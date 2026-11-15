"""Voice service: command handling, worker threads, event emission."""
import gc
import logging
import queue
import threading
import time
from collections import deque
from dataclasses import replace
from typing import Any, Callable, Dict, Optional

import numpy as np

from . import FEATURES, PROTOCOL_VERSION
from .audio.wavio import wav_bytes
from .clock import now_ms
from .protocol import Emitter
from .settings import Settings, SttSettings
from .stt.transcript_filter import check_transcript
from .vad.segmenter import Segmenter, SegmenterParams

log = logging.getLogger("voice_service")

MIC_LEVEL_EVERY_FRAMES = 6      # ~190 ms
MIC_STATS_EVERY_MS = 5000.0     # while listening without a completed utterance
# Peak levels (full scale = 1.0) used to describe what a microphone delivers.
# A real microphone has a noise floor; exact zeros come from a muted, virtual
# or blocked device.
DIGITAL_SILENCE_PEAK = 1e-4     # -80 dBFS
VERY_QUIET_PEAK = 3e-3          # about -50 dBFS: no usable voice at this level


def classify_signal(frames: int, peak: float) -> str:
    """no_frames | digital_silence | very_quiet | ok   (pure, unit tested)"""
    if frames <= 0:
        return "no_frames"
    if peak < DIGITAL_SILENCE_PEAK:
        return "digital_silence"
    if peak < VERY_QUIET_PEAK:
        return "very_quiet"
    return "ok"
FRAME_QUEUE_MAX = 600           # ~19 s of audio
# a returned TTS chunk (VC-M3.2) larger than this is refused (same limit as the Core → avatar engine)
MAX_RETURN_BYTES = 4 * 1024 * 1024
KEEP_UTTERANCES = 12            # recent utterance audio kept in RAM for STT comparison


class Factories:
    """Construction of the real engines. Tests inject fakes instead."""

    def make_vad(self):
        from .vad.silero_onnx import SileroVadOnnx
        return SileroVadOnnx()

    def make_audio_in(self, on_frame):
        from .audio.capture import AudioInput
        return AudioInput(on_frame)

    def make_audio_out(self, sample_rate, on_event):
        from .audio.playback import AudioOutput
        return AudioOutput(sample_rate, on_event)

    def make_stt(self, s: SttSettings, models_dir: str):
        from .stt.faster_whisper_stt import FasterWhisperStt
        return FasterWhisperStt(s.model, s.device, s.compute_type, s.language, s.beam_size, models_dir)

    def make_tts(self, s, models_dir: str):
        from .tts.silero_tts import SileroTts
        return SileroTts(s.model_id, s.voice, s.device, s.threads, s.sample_rate, models_dir, s.language)

    def list_devices(self, host_api_pref: str):
        from .audio import devices
        return devices.list_devices(host_api_pref)

    def resources(self):
        from . import resources
        return resources.snapshot()


def _vad_params(settings: Settings) -> SegmenterParams:
    v = settings.vad
    return SegmenterParams(
        threshold=v.threshold,
        min_speech_ms=v.min_speech_ms,
        min_silence_ms=v.min_silence_ms,
        speech_pad_ms=v.speech_pad_ms,
        max_utterance_ms=v.max_utterance_ms,
    )


class VoiceService:
    def __init__(self, emitter: Emitter, factories: Optional[Factories] = None):
        self.out = emitter
        self.f = factories or Factories()
        self.settings = Settings()
        self.stopped = False

        self.vad = None
        self.segmenter = Segmenter(_vad_params(self.settings))
        self.audio_in = None
        self.audio_out = None
        self.stt = None
        self.tts = None

        # microphone gate
        self._listening = False
        self._gate_open_at = 0.0
        self._needs_vad_reset = True
        self._frame_count = 0
        self._level_peak = 0.0
        self._level_prob = 0.0
        self._dropped_frames = 0
        self._win = self._new_window()   # what the microphone delivered since the gate last opened
        self._status_signal = "ok"       # signal state last shown in the mic status (assumed fine until measured)
        self._stt_counts = {"requests": 0, "final": 0, "discarded": 0, "last_reason": ""}

        # tts bookkeeping
        self._tts_lock = threading.Lock()
        self._tts_generation = 0
        self._turns: Dict[str, Dict[str, Any]] = {}

        self._recent_utterances = deque(maxlen=KEEP_UTTERANCES)
        self._stt_failed = False

        self._frame_q: "queue.Queue" = queue.Queue(maxsize=FRAME_QUEUE_MAX)
        self._stt_q: "queue.Queue" = queue.Queue()
        self._tts_q: "queue.Queue" = queue.Queue()
        self._admin_q: "queue.Queue" = queue.Queue()
        self._threads = []
        for name, target in (("vad", self._vad_loop), ("stt", self._stt_loop),
                             ("tts", self._tts_loop), ("admin", self._admin_loop)):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)

    # ------------------------------------------------------------ commands --

    def hello(self) -> None:
        """Announce this process.

        `pid` is the process that runs the service code. On Windows it is NOT
        the process the parent started when the interpreter was launched
        through a venv launcher (`.venv\\Scripts\\python.exe` starts the real
        interpreter as a child). `parent_pid` and `ancestors` let the owner
        verify that relationship explicitly instead of assuming pid equality.
        """
        import os
        import platform
        import sys
        ancestors = [os.getppid()]
        executable = sys.executable
        via_launcher = None  # unknown without psutil
        try:
            import psutil
            me = psutil.Process(os.getpid())
            executable = me.exe() or sys.executable   # the real image, not the launcher path
            ancestors = [p.pid for p in me.parents()[:6]]
            try:
                via_launcher = not os.path.samefile(executable, sys.executable)
            except OSError:
                via_launcher = os.path.normcase(executable) != os.path.normcase(sys.executable)
        except Exception:
            pass
        self.out.emit("hello", protocol=PROTOCOL_VERSION, pid=os.getpid(), parent_pid=os.getppid(),
                      ancestors=ancestors, executable=executable, launched_as=sys.executable,
                      via_launcher=via_launcher,
                      python=platform.python_version(), platform=sys.platform, features=list(FEATURES))

    def handle(self, msg: Dict[str, Any]) -> None:
        cmd = msg.get("cmd")
        handler: Optional[Callable[[Dict[str, Any]], None]] = getattr(self, f"_cmd_{cmd}", None)
        if handler is None:
            self._reply_error(msg, f"unknown command: {cmd}")
            return
        try:
            handler(msg)
        except Exception as exc:  # never let one bad command kill the service
            log.exception("command %s failed", cmd)
            self._reply_error(msg, f"{cmd} failed: {exc}")

    def _reply_error(self, msg: Dict[str, Any], message: str) -> None:
        fields: Dict[str, Any] = {"message": message}
        if "id" in msg:
            fields["reply_to"] = msg["id"]
        self.out.emit("error", **fields)

    def _cmd__malformed(self, msg) -> None:
        self.out.emit("error", message=f"malformed command line: {msg.get('raw', '')}")

    def _cmd_clock_sync(self, msg) -> None:
        self.out.emit("clock_sync", reply_to=msg.get("id"), service_now_ms=now_ms())

    def _cmd_init(self, msg) -> None:
        self._admin_q.put(("init", Settings.from_dict(msg.get("config") or {})))

    def _cmd_configure(self, msg) -> None:
        self._admin_q.put(("configure", Settings.from_dict(msg.get("config") or {})))

    def _cmd_list_devices(self, msg) -> None:
        listing = self.f.list_devices(self.settings.audio.host_api)
        self.out.emit("devices", reply_to=msg.get("id"), **listing)

    def _cmd_get_resources(self, msg) -> None:
        def work():
            try:
                self.out.emit("resources", reply_to=msg.get("id"), **self.f.resources())
            except Exception as exc:
                self._reply_error(msg, f"resources failed: {exc}")
        threading.Thread(target=work, name="resources", daemon=True).start()

    def _cmd_set_listening(self, msg) -> None:
        self._set_listening(bool(msg.get("enabled")), reason="command")

    def _cmd_get_mic_stats(self, msg) -> None:
        self.out.emit("mic_stats", reply_to=msg.get("id"), **self._mic_stats("request"))

    def _cmd_tts_speak(self, msg) -> None:
        turn_id = str(msg.get("turn_id"))
        seq = int(msg.get("seq", 0))
        text = str(msg.get("text") or "")
        # optional: a voice for this request only (voice preview); normally absent
        voice = str(msg.get("voice") or "") or None
        # deliver="return" (VC-M3.2): synthesize, then send the audio back to the core
        # (it plays elsewhere, e.g. through the photo-animation engine) instead of playing it here.
        # Such chunks are not tracked as local playback: no tts_playback_*/tts_drained for them.
        ret = msg.get("deliver") == "return"
        with self._tts_lock:
            gen = self._tts_generation
            if not ret:
                self._turns.setdefault(turn_id, {"queued": 0, "played": 0, "ended": False, "last_end": None, "gen": gen})
        self._tts_q.put(("speak", gen, turn_id, seq, text, now_ms(), voice, ret))

    def _cmd_tts_end_turn(self, msg) -> None:
        turn_id = str(msg.get("turn_id"))
        with self._tts_lock:
            gen = self._tts_generation
            self._turns.setdefault(turn_id, {"queued": 0, "played": 0, "ended": False, "last_end": None, "gen": gen})
        self._tts_q.put(("end", gen, turn_id))

    def _cmd_tts_stop(self, msg) -> None:
        self._stop_tts()

    def _cmd_stt_retranscribe(self, msg) -> None:
        self._admin_q.put(("retranscribe", msg))

    def _cmd_shutdown(self, msg) -> None:
        self.shutdown()

    # ----------------------------------------------------------- lifecycle --

    def shutdown(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        self._listening = False
        for closer in (self.audio_in, self.audio_out):
            if closer is not None:
                try:
                    closer.close()
                except Exception:
                    pass
        for comp in ("mic", "vad", "stt", "tts", "output"):
            self.out.status(comp, "stopped", "Voice service shut down")
        self.out.emit("bye")

    # ------------------------------------------------------------- loading --

    def _admin_loop(self) -> None:
        while True:
            kind, payload = self._admin_q.get()
            if self.stopped:
                return
            try:
                if kind == "init":
                    self._apply_settings(payload, initial=True)
                elif kind == "configure":
                    self._apply_settings(payload, initial=False)
                elif kind == "retranscribe":
                    self._retranscribe(payload)
            except Exception as exc:
                log.exception("admin task %s failed", kind)
                self.out.emit("error", message=f"{kind} failed: {exc}")

    def _apply_settings(self, new: Settings, initial: bool) -> None:
        old = self.settings
        self.settings = new
        self.segmenter.set_params(_vad_params(new))

        audio_changed = initial or old.audio.host_api != new.audio.host_api
        if initial or audio_changed or old.audio.output_device != new.audio.output_device \
                or old.tts.sample_rate != new.tts.sample_rate:
            self._load_output()
        if initial:
            self._load_vad()
        if initial or audio_changed or old.audio.input_device != new.audio.input_device:
            self._load_mic()
        tts_reload = initial or (old.tts.model_id, old.tts.device, old.tts.threads, old.tts.sample_rate, old.tts.language) != \
            (new.tts.model_id, new.tts.device, new.tts.threads, new.tts.sample_rate, new.tts.language)
        if tts_reload:
            self._load_tts()
        elif old.tts.voice != new.tts.voice and self.tts is not None:
            if self.tts.set_voice(new.tts.voice):
                self.out.status("tts", "ready", f"voice {new.tts.voice}", **self.tts.describe())
            else:
                self.out.status("tts", "ready", f"voice '{new.tts.voice}' not available; still using {self.tts.voice}",
                                **self.tts.describe())
        if initial or old.stt != new.stt:
            self._load_stt()

    def _load_output(self) -> None:
        self.out.status("output", "loading", "Opening audio output")
        try:
            if self.audio_out is not None:
                self.audio_out.close()
            self.audio_out = self.f.make_audio_out(self.settings.tts.sample_rate, self._on_playback_event)
            notes = self.audio_out.open(self.settings.audio.output_device, self.settings.audio.host_api)
            self.out.status("output", "ready", "; ".join(notes) or self.audio_out.device_name,
                            device=self.audio_out.device_name, host_api=self.audio_out.host_api,
                            output_latency_ms=round(self.audio_out.latency_ms, 1),
                            sample_rate=self.settings.tts.sample_rate)
        except Exception as exc:
            log.exception("audio output failed")
            self.audio_out = None
            self.out.status("output", "error", str(exc))

    def _load_vad(self) -> None:
        self.out.status("vad", "loading", "Loading Silero VAD")
        try:
            self.vad = self.f.make_vad()
            self._needs_vad_reset = True
            self.out.status("vad", "ready", "Silero VAD (ONNX)", provider="silero-vad",
                            frame_ms=round(self.segmenter.frame_ms, 1))
        except Exception as exc:
            log.exception("VAD failed")
            self.vad = None
            self.out.status("vad", "error", str(exc))

    def _load_mic(self) -> None:
        self.out.status("mic", "loading", "Opening microphone")
        try:
            if self.audio_in is not None:
                self.audio_in.close()
            self.audio_in = self.f.make_audio_in(self._on_mic_frame)
            notes = self.audio_in.open(self.settings.audio.input_device, self.settings.audio.host_api)
            self._needs_vad_reset = True
            self._status_signal = "ok"
            self.out.status("mic", "ready", "; ".join(notes) or self.audio_in.device_name,
                            device=self.audio_in.device_name, host_api=self.audio_in.host_api,
                            input_latency_ms=round(self.audio_in.latency_ms, 1))
        except Exception as exc:
            log.exception("microphone failed")
            self.audio_in = None
            self.out.status("mic", "error", str(exc))

    def _load_tts(self) -> None:
        s = self.settings.tts
        self.out.status("tts", "loading", f"Loading Silero TTS {s.model_id} ({s.language}) on {s.device}")
        try:
            self.tts = None
            gc.collect()
            tts = self.f.make_tts(s, self.settings.models_dir)
            tts.load()
            self.tts = tts
            info = tts.describe()
            self.out.status("tts", "ready", "; ".join(info.get("notes") or []) or f"{info['model']} / {info['voice']} ({info.get('language', '?')}) on {info['device']}", **info)
        except Exception as exc:
            log.exception("TTS failed")
            self.tts = None
            self.out.status("tts", "error", f"{type(exc).__name__}: {exc}")

    def _load_stt(self) -> None:
        s = self.settings.stt
        self.out.status("stt", "loading", f"Loading faster-whisper {s.model} on {s.device} ({s.compute_type})")
        try:
            self.stt = None
            gc.collect()
            stt = self.f.make_stt(s, self.settings.models_dir)
            stt.load()
            self.stt = stt
            info = stt.describe()
            self.out.status("stt", "ready", "; ".join(info.get("notes") or []) or f"{info['model']} on {info['device']} ({info['compute_type']}), language {info.get('language', '?')}", **info)
        except Exception as exc:
            log.exception("STT failed")
            self.stt = None
            self.out.status("stt", "error", f"{type(exc).__name__}: {exc}")

    # ---------------------------------------------------------- microphone --

    def _new_window(self) -> Dict[str, Any]:
        t = now_ms()
        return {"t_open": t, "t_last_emit": t, "frames": 0, "before_gate": 0, "samples": 0, "peak": 0.0,
                "sum_sq": 0.0, "max_prob": 0.0, "over_threshold": 0, "speech_starts": 0, "speech_ends": 0,
                "discarded_short": 0}

    def _mic_stats(self, reason: str) -> Dict[str, Any]:
        """What the microphone delivered since the gate last opened (the "listen window")."""
        w = self._win
        stream: Dict[str, Any] = {}
        stats = getattr(self.audio_in, "stats", None)
        if callable(stats):
            try:
                stream = stats()
            except Exception:  # diagnostics must never break the service
                stream = {}
        elif self.audio_in is not None:
            stream = {"device": self.audio_in.device_name, "host_api": self.audio_in.host_api}
        rms = float(np.sqrt(w["sum_sq"] / w["samples"])) if w["samples"] else 0.0
        return {
            "reason": reason,
            "t": now_ms(),
            "mic_open": self.audio_in is not None,
            "stream": stream,
            "listening": self._listening,
            "window_ms": round(now_ms() - w["t_open"], 1),
            "frames": w["frames"],
            "frames_before_gate": w["before_gate"],
            "frames_dropped": self._dropped_frames,
            "peak": round(w["peak"], 5),
            "rms": round(rms, 5),
            "signal": classify_signal(w["frames"], w["peak"]),
            "vad_ready": self.vad is not None,
            "vad_threshold": self.settings.vad.threshold,
            "max_speech_prob": round(w["max_prob"], 4),
            "frames_over_threshold": w["over_threshold"],
            "speech_starts": w["speech_starts"],
            "speech_ends": w["speech_ends"],
            "discarded_short": w["discarded_short"],
            # is a speech candidate open right now? (False after a too-short sound was discarded)
            "in_speech": bool(self.segmenter.in_speech),
            "stt": dict(self._stt_counts),
        }

    def _emit_mic_stats(self, reason: str) -> None:
        stats = self._mic_stats(reason)
        self._win["t_last_emit"] = stats["t"]
        self.out.emit("mic_stats", **stats)

    def _set_listening(self, enabled: bool, reason: str) -> None:
        was = self._listening
        if enabled:
            self._gate_open_at = now_ms() + self.settings.audio.listen_resume_delay_ms
            self._needs_vad_reset = True
            self._win = self._new_window()
        self._listening = enabled
        self.out.emit("listening", enabled=enabled, reason=reason, t=now_ms())
        if was and not enabled:
            self._emit_mic_stats("listening_closed")

    def _on_mic_frame(self, frame: np.ndarray, t_frame_end: float) -> None:
        """Called from the audio thread: must stay cheap and non-blocking."""
        if not self._listening:
            return
        try:
            self._frame_q.put_nowait((frame, t_frame_end))
        except queue.Full:
            self._dropped_frames += 1

    def _vad_loop(self) -> None:
        while True:
            frame, t_end = self._frame_q.get()
            if self.stopped:
                return
            # frames captured before the gate (re)opened are ignored, so the
            # tail of the companion's own speech can never start an utterance
            if not self._listening:
                continue
            w = self._win
            if t_end - self.segmenter.frame_ms < self._gate_open_at:
                w["before_gate"] += 1
                continue
            # level of what the device delivers, counted even if the VAD is unavailable
            peak = float(np.max(np.abs(frame))) if len(frame) else 0.0
            w["frames"] += 1
            w["samples"] += len(frame)
            w["sum_sq"] += float(np.dot(frame, frame))
            if peak > w["peak"]:
                w["peak"] = peak
            vad = self.vad
            if vad is None:
                self._maybe_report_window(t_end)
                continue
            try:
                if self._needs_vad_reset:
                    self._needs_vad_reset = False
                    vad.reset()
                    self.segmenter.reset()
                prob = vad(frame)
                if prob > w["max_prob"]:
                    w["max_prob"] = prob
                if prob >= self.settings.vad.threshold:
                    w["over_threshold"] += 1
                self._mic_level(frame, prob)
                for ev in self.segmenter.process(prob, frame, t_end):
                    self._on_segment_event(ev)
                self._maybe_report_window(t_end)
            except Exception as exc:
                log.exception("VAD processing failed")
                self.out.status("vad", "error", f"{type(exc).__name__}: {exc}")
                self.vad = None

    def _maybe_report_window(self, t_now: float) -> None:
        """While the gate stays open without a finished utterance, say what is arriving."""
        w = self._win
        if not self._listening or t_now - w["t_last_emit"] < MIC_STATS_EVERY_MS:
            return
        self._emit_mic_stats("periodic")
        signal = classify_signal(w["frames"], w["peak"])
        if signal != self._status_signal and self.audio_in is not None:
            # "ready" only means the stream opened; say so when nothing is coming
            # through it (and again when a signal appears). Reported on change only.
            self._status_signal = signal
            name = self.audio_in.device_name
            if signal == "digital_silence":
                self.out.status("mic", "ready", f"{name}: no sound so far (the device delivers digital silence)",
                                device=name, host_api=self.audio_in.host_api, signal=signal)
            elif signal == "very_quiet":
                self.out.status("mic", "ready", f"{name}: signal is very quiet (peak {w['peak']:.4f})",
                                device=name, host_api=self.audio_in.host_api, signal=signal)
            else:
                self.out.status("mic", "ready", name, device=name, host_api=self.audio_in.host_api, signal=signal)

    def _mic_level(self, frame: np.ndarray, prob: float = 0.0) -> None:
        self._level_peak = max(self._level_peak, float(np.max(np.abs(frame))) if len(frame) else 0.0)
        self._level_prob = max(self._level_prob, float(prob))
        self._frame_count += 1
        if self._frame_count % MIC_LEVEL_EVERY_FRAMES == 0:
            rms = float(np.sqrt(np.mean(np.square(frame)))) if len(frame) else 0.0
            self.out.emit("mic_level", rms=round(rms, 5), peak=round(self._level_peak, 5),
                          prob=round(self._level_prob, 3), in_speech=self.segmenter.in_speech)
            self._level_peak = 0.0
            self._level_prob = 0.0

    def _on_segment_event(self, ev: Dict[str, Any]) -> None:
        kind = ev["type"]
        if kind == "speech_start":
            self._win["speech_starts"] += 1
            self.out.emit("speech_start", utterance_id=ev["utterance_id"], t_speech_start=ev["t_speech_start"])
        elif kind == "speech_discarded":
            self._win["discarded_short"] += 1
            self.out.emit("speech_discarded", utterance_id=ev["utterance_id"], reason=ev["reason"],
                          speech_ms=round(ev["speech_ms"], 1))
        elif kind == "speech_end":
            self._win["speech_ends"] += 1
            self._stt_counts["requests"] += 1
            # One utterance at a time: close the gate until the core reopens it.
            self._listening = False
            self._emit_mic_stats("speech_end")
            self.out.emit("speech_end", utterance_id=ev["utterance_id"],
                          t_speech_start=ev["t_speech_start"], t_speech_end=ev["t_speech_end"],
                          t_vad_end_detected=ev["t_vad_end_detected"],
                          speech_ms=round(ev["speech_ms"], 1), forced=ev["forced"])
            self._stt_q.put(ev)

    # ----------------------------------------------------------------- STT --

    def _stt_loop(self) -> None:
        while True:
            ev = self._stt_q.get()
            if self.stopped:
                return
            uid = ev["utterance_id"]
            audio = ev["audio"]
            audio_ms = len(audio) * 1000.0 / 16000.0
            stt = self.stt
            if stt is None:
                self._stt_counts["discarded"] += 1
                self._stt_counts["last_reason"] = "stt_not_ready"
                self.out.emit("stt_discarded", utterance_id=uid, reason="stt_not_ready", text="")
                continue
            t_start = now_ms()
            try:
                result = stt.transcribe(audio)
            except Exception as exc:
                log.exception("transcription failed")
                self._stt_counts["discarded"] += 1
                self._stt_counts["last_reason"] = f"stt_error: {type(exc).__name__}"
                self.out.emit("stt_discarded", utterance_id=uid, reason=f"stt_error: {exc}", text="")
                self.out.status("stt", "error", f"{type(exc).__name__}: {exc}")
                self._stt_failed = True
                continue
            t_done = now_ms()
            if self._stt_failed:
                self._stt_failed = False
                self.out.status("stt", "ready", "recovered after an error", **stt.describe())
            self._recent_utterances.append({"utterance_id": uid, "audio": audio, "audio_ms": audio_ms,
                                            "text": result["text"], "stt_ms": t_done - t_start})
            info = stt.describe()
            accept, reason = check_transcript(result["text"], result.get("no_speech_prob"), result.get("avg_logprob"),
                                              language=str(info.get("language") or "ru"))
            common = dict(
                utterance_id=uid, text=result["text"], t_stt_start=t_start, t_stt_final=t_done,
                stt_ms=round(t_done - t_start, 1), audio_ms=round(audio_ms, 1),
                model=info.get("model"), device=info.get("device"), compute_type=info.get("compute_type"),
                language=result.get("language") or info.get("language"),
                avg_logprob=result.get("avg_logprob"), no_speech_prob=result.get("no_speech_prob"),
            )
            if accept:
                self._stt_counts["final"] += 1
                self._stt_counts["last_reason"] = "ok"
                self.out.emit("stt_final", **common)
            else:
                self._stt_counts["discarded"] += 1
                self._stt_counts["last_reason"] = reason
                self.out.emit("stt_discarded", reason=reason, **common)

    def _retranscribe(self, msg: Dict[str, Any]) -> None:
        """Re-run recent utterances through another Whisper model (same audio)."""
        base = self.settings.stt
        alt = replace(base, model=str(msg.get("model") or base.model),
                      device=str(msg.get("device") or base.device),
                      compute_type=str(msg.get("compute_type") or base.compute_type))
        utterances = list(self._recent_utterances)
        stt = self.f.make_stt(alt, self.settings.models_dir)
        stt.load()
        results = []
        for u in utterances:
            t0 = time.perf_counter()
            r = stt.transcribe(u["audio"])
            results.append({
                "utterance_id": u["utterance_id"], "audio_ms": round(u["audio_ms"], 1),
                "text": r["text"], "stt_ms": round((time.perf_counter() - t0) * 1000.0, 1),
                "reference_text": u["text"], "reference_stt_ms": round(u["stt_ms"], 1),
            })
        info = stt.describe()
        del stt
        gc.collect()
        self.out.emit("stt_retranscribe_result", reply_to=msg.get("id"), model=info, results=results)

    # ----------------------------------------------------------------- TTS --

    def _tts_loop(self) -> None:
        while True:
            item = self._tts_q.get()
            if self.stopped:
                return
            kind, gen, turn_id = item[0], item[1], item[2]
            if gen != self._tts_generation:
                continue  # stopped meanwhile
            if kind == "end":
                with self._tts_lock:
                    turn = self._turns.get(turn_id)
                    if turn is not None:
                        turn["ended"] = True
                self._check_drained(turn_id)
                continue
            _, _, _, seq, text, t_accepted, voice, ret = item
            tts, out = self.tts, self.audio_out
            if tts is None or (out is None and not ret):
                self.out.emit("tts_error", turn_id=turn_id, seq=seq,
                              message="TTS is not ready" if tts is None else "audio output is not ready")
                continue
            t0 = now_ms()
            try:
                # the speaker is chosen per synthesis: the configured voice, or the
                # voice named in this request (an unknown one raises, no fallback)
                audio = tts.synthesize(text, voice) if voice else tts.synthesize(text)
                used_voice = voice or getattr(tts, "voice", None)
            except Exception as exc:
                log.exception("synthesis failed")
                self.out.emit("tts_error", turn_id=turn_id, seq=seq, message=f"{type(exc).__name__}: {exc}")
                continue
            t1 = now_ms()
            if gen != self._tts_generation:
                continue
            audio_ms = len(audio) * 1000.0 / tts.sample_rate
            self.out.emit("tts_synth_done", turn_id=turn_id, seq=seq, t_accepted=t_accepted,
                          t_synth_start=t0, t_synth_done=t1, synth_ms=round(t1 - t0, 1),
                          audio_ms=round(audio_ms, 1), chars=len(text), voice=used_voice)
            if len(audio) == 0:
                continue  # nothing speakable in this chunk (e.g. only symbols)
            if ret:
                self._return_audio(gen, turn_id, seq, audio, tts.sample_rate, audio_ms)
                continue
            with self._tts_lock:
                if gen != self._tts_generation:
                    continue
                turn = self._turns.get(turn_id)
                if turn is None:
                    continue
                turn["queued"] += 1
            try:
                out.play(audio, (gen, turn_id, seq))
            except Exception as exc:
                self.out.emit("tts_error", turn_id=turn_id, seq=seq, message=f"playback failed: {exc}")

    def _return_audio(self, gen: int, turn_id: str, seq: int, audio, sample_rate: int, audio_ms: float) -> None:
        """Send one synthesized chunk back to the core as WAV bytes (binary frame)."""
        t0 = now_ms()
        data = wav_bytes(audio, sample_rate)
        if len(data) > MAX_RETURN_BYTES:
            self.out.emit("tts_error", turn_id=turn_id, seq=seq,
                          message=f"chunk of {round(audio_ms)} ms is too long to send ({len(data)} bytes)")
            return
        # a stop between synthesis and here: the chunk is dropped, never delivered late
        with self._tts_lock:
            if gen != self._tts_generation:
                return
        self.out.emit_binary("tts_audio", data, turn_id=turn_id, seq=seq, format="wav", sample_rate=int(sample_rate),
                             channels=1, audio_ms=round(audio_ms, 1), t_encoded=now_ms(),
                             encode_ms=round(now_ms() - t0, 2))

    def _on_playback_event(self, kind: str, tag: Any, t_ms: float) -> None:
        gen, turn_id, seq = tag
        if gen != self._tts_generation:
            return
        if kind == "start":
            latency = self.audio_out.latency_ms if self.audio_out is not None else None
            self.out.emit("tts_playback_start", turn_id=turn_id, seq=seq, t_playback_start=t_ms,
                          approximate=True, output_latency_ms=None if latency is None else round(latency, 1))
        elif kind == "end":
            self.out.emit("tts_playback_end", turn_id=turn_id, seq=seq, t_playback_end=t_ms)
            with self._tts_lock:
                turn = self._turns.get(turn_id)
                if turn is not None:
                    turn["played"] += 1
                    turn["last_end"] = t_ms
            self._check_drained(turn_id)

    def _check_drained(self, turn_id: str) -> None:
        with self._tts_lock:
            turn = self._turns.get(turn_id)
            if turn is None or not turn["ended"] or turn["played"] < turn["queued"]:
                return
            del self._turns[turn_id]
        self.out.emit("tts_drained", turn_id=turn_id, chunks=turn["queued"], aborted=False,
                      t_playback_end=turn["last_end"] if turn["last_end"] is not None else now_ms())

    def _stop_tts(self) -> None:
        with self._tts_lock:
            self._tts_generation += 1
            turns = list(self._turns.keys())
            self._turns.clear()
        if self.audio_out is not None:
            self.audio_out.flush()
        for turn_id in turns:
            self.out.emit("tts_drained", turn_id=turn_id, chunks=0, aborted=True, t_playback_end=now_ms())
