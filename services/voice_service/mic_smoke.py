"""Direct microphone smoke test: real device, real Silero VAD, real faster-whisper.

    python -m services.voice_service.mic_smoke --input-device "" --stt-model small ...

(normally started through mic_smoke.bat / scripts/mic_smoke.js, which pass the
values of the application configuration, so the SAME microphone is opened in
the SAME way as in the application: the application's AudioInput class,
16 kHz, mono, 512-sample blocks).

What it answers, in this order:
  1. Which input devices exist and which one the application uses.
  2. Do the VAD and Whisper work at all on this PC? (a known speech recording,
     if one is available, is run through them; no microphone involved)
  3. Does the selected microphone deliver audio frames, and at what level?
  4. Does the VAD see speech in them (start, end)?
  5. Is a segment sent to Whisper, and what text comes back?

While you speak it also records the same device in its own format (native
sample rate, all channels), so "the conversion to 16 kHz mono loses the voice"
can be told apart from "the device did not deliver the voice".

It never changes the Windows default device and never switches to another
device. If the selected device is silent it only MEASURES the other input
devices for comparison.
"""
import argparse
import json
import os
import queue
import sys
import time
from typing import Any, Callable, Dict, List, Optional

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import numpy as np

from .audio.wavio import read_wav_16k, resample, write_wav
from .service import DIGITAL_SILENCE_PEAK, VERY_QUIET_PEAK, classify_signal
from .stt.transcript_filter import check_transcript
from .vad.segmenter import Segmenter, SegmenterParams

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512
DEFAULT_SENTENCE = "Сегодня хорошая погода, и я собираюсь пойти гулять в парк."


class Deps:
    """The real engines. Unit tests replace these with fakes."""

    def list_devices(self, host_api: str) -> Dict[str, Any]:
        from .audio import devices
        return devices.list_devices(host_api)

    def make_input(self, on_frame):
        from .audio.capture import AudioInput
        return AudioInput(on_frame)

    def make_native(self):
        from .audio.capture import NativeRecorder
        return NativeRecorder()

    def make_vad(self):
        from .vad.silero_onnx import SileroVadOnnx
        return SileroVadOnnx()

    def make_stt(self, args):
        from .stt.faster_whisper_stt import FasterWhisperStt
        return FasterWhisperStt(args.stt_model, args.stt_device, args.compute_type, args.language,
                                args.beam_size, args.models_dir)

    now = staticmethod(time.perf_counter)


def _dbfs(value: float) -> str:
    return "-inf dBFS" if value <= 0 else f"{20.0 * np.log10(value):.1f} dBFS"


def _meter(peak: float, width: int = 20) -> str:
    # -60 dBFS .. 0 dBFS mapped onto the bar
    level = 0.0 if peak <= 0 else max(0.0, min(1.0, (20.0 * np.log10(peak) + 60.0) / 60.0))
    filled = int(round(level * width))
    return "#" * filled + "." * (width - filled)


def _vad_params(args: argparse.Namespace) -> SegmenterParams:
    return SegmenterParams(threshold=args.vad_threshold, min_speech_ms=args.min_speech_ms,
                           min_silence_ms=args.min_silence_ms, speech_pad_ms=args.speech_pad_ms,
                           max_utterance_ms=args.max_utterance_sec * 1000.0)


def _segment(audio: np.ndarray, vad: Any, params: SegmenterParams) -> Dict[str, Any]:
    """Run a whole 16 kHz recording through the VAD and the segmenter."""
    vad.reset()
    seg = Segmenter(params)
    probs: List[float] = []
    segments: List[Dict[str, Any]] = []
    starts = 0
    for i in range(0, len(audio) - FRAME_SAMPLES + 1, FRAME_SAMPLES):
        frame = audio[i:i + FRAME_SAMPLES]
        p = float(vad(frame))
        probs.append(p)
        for ev in seg.process(p, frame, (i + FRAME_SAMPLES) * 1000.0 / SAMPLE_RATE):
            if ev["type"] == "speech_start":
                starts += 1
            elif ev["type"] == "speech_end":
                segments.append(ev)
    return {"probs": probs, "segments": segments, "speech_starts": starts,
            "max_prob": max(probs) if probs else 0.0,
            "frames_over_threshold": sum(1 for p in probs if p >= params.threshold)}


def _transcribe(stt: Any, audio: np.ndarray, language: str, now: Callable[[], float]) -> Dict[str, Any]:
    t0 = now()
    result = stt.transcribe(audio)
    stt_ms = (now() - t0) * 1000.0
    accept, reason = check_transcript(result.get("text", ""), result.get("no_speech_prob"), result.get("avg_logprob"),
                                      language=language)
    return {"text": result.get("text", ""), "stt_ms": round(stt_ms, 1), "audio_ms": round(len(audio) * 1000.0 / SAMPLE_RATE, 1),
            "avg_logprob": result.get("avg_logprob"), "no_speech_prob": result.get("no_speech_prob"),
            "language": result.get("language"), "accepted": bool(accept), "filter": reason}


def _activity(audio: np.ndarray) -> Dict[str, Any]:
    """When was there sound at all? Exact zeros mean the source delivered nothing."""
    if len(audio) == 0:
        return {"zero_share": 0.0, "first_sound_s": None, "last_sound_s": None, "per_second_peak": []}
    loud = np.flatnonzero(np.abs(audio) > DIGITAL_SILENCE_PEAK)
    seconds = int(np.ceil(len(audio) / SAMPLE_RATE))
    return {
        "zero_share": round(float(np.mean(audio == 0)), 4),
        "first_sound_s": round(float(loud[0]) / SAMPLE_RATE, 2) if len(loud) else None,
        "last_sound_s": round(float(loud[-1]) / SAMPLE_RATE, 2) if len(loud) else None,
        "per_second_peak": [round(float(np.max(np.abs(audio[i * SAMPLE_RATE:(i + 1) * SAMPLE_RATE]))), 4) for i in range(seconds)],
    }


def _analyze_native(audio: np.ndarray, rate: int, vad: Any, params: SegmenterParams):
    """Speech content of a device's unconverted signal, per channel and for two mixes.

    Returns (json-serializable summary, {variant name: speech audio at 16 kHz}).
    The "difference" mix finds a voice that a mono mix cancels (channels in
    opposite phase); the per-channel rows find a voice present in one channel only.
    """
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio.reshape(-1, 1)
    channels = audio.shape[1]
    named = [(f"channel {c + 1}", audio[:, c]) for c in range(channels)]
    correlation = None
    if channels >= 2:
        named.append(("mono mix (mean of channels)", audio.mean(axis=1)))
        named.append(("difference (ch1 - ch2)/2", (audio[:, 0] - audio[:, 1]) / 2.0))
        if len(audio) > 1 and float(np.std(audio[:, 0])) > 0 and float(np.std(audio[:, 1])) > 0:
            correlation = round(float(np.corrcoef(audio[:, 0], audio[:, 1])[0, 1]), 4)
    variants: List[Dict[str, Any]] = []
    speech: Dict[str, np.ndarray] = {}
    for name, x in named:
        res = _segment(resample(x, rate, SAMPLE_RATE), vad, params)
        variants.append({
            "name": name,
            "peak": round(float(np.max(np.abs(x))) if len(x) else 0.0, 5),
            "rms": round(float(np.sqrt(np.mean(np.square(x)))) if len(x) else 0.0, 6),
            "zero_share": round(float(np.mean(x == 0)) if len(x) else 0.0, 4),
            "max_speech_prob": round(float(res["max_prob"]), 4),
            "frames_over_threshold": int(res["frames_over_threshold"]),
            "speech_starts": int(res["speech_starts"]),
            "utterances": len(res["segments"]),
        })
        if res["segments"]:
            speech[name] = np.concatenate([s["audio"] for s in res["segments"]])
    summary = {"seconds": round(len(audio) / float(rate), 2) if rate else 0.0, "variants": variants,
               "channel_correlation": correlation}
    return summary, speech


def _same_device(opened: str, wanted: str) -> bool:
    """Device names match; MME truncates names to 31 characters."""
    return bool(opened) and (opened == wanted or wanted.startswith(opened) or opened.startswith(wanted))


def _has_letters_of(text: str, language: str) -> bool:
    if language == "ru":
        return any("а" <= ch.lower() <= "я" or ch.lower() == "ё" for ch in text)
    return any(ch.isalpha() for ch in text)


def _record(mic_factory: Callable[..., Any], device_name: str, host_api: str, seconds: float,
            on_frame: Optional[Callable[[np.ndarray, float], bool]], now: Callable[[], float],
            after_open: Optional[Callable[[], None]] = None) -> Dict[str, Any]:
    """Open the device like the application does and collect frames for a bounded time.

    on_frame(frame, elapsed_s) may return True to stop early.
    after_open() runs once the application-format stream is open.
    """
    frames_q: "queue.Queue" = queue.Queue()
    mic = mic_factory(lambda frame, t_end: frames_q.put(frame))
    out: Dict[str, Any] = {"requested_device": device_name or "(system default)", "opened": False, "notes": [], "error": None}
    t_open = now()
    try:
        out["notes"] = mic.open(device_name, host_api)
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out
    out["opened"] = True
    out["open_ms"] = round((now() - t_open) * 1000.0, 1)
    if after_open is not None:
        after_open()
    collected: List[np.ndarray] = []
    t0 = now()
    try:
        while True:
            elapsed = now() - t0
            if elapsed >= seconds:
                break
            try:
                frame = frames_q.get(timeout=min(0.1, max(0.01, seconds - elapsed)))
            except queue.Empty:
                continue
            collected.append(frame)
            if on_frame is not None and on_frame(frame, now() - t0):
                break
    finally:
        stats = mic.stats() if callable(getattr(mic, "stats", None)) else {}
        out["device"] = getattr(mic, "device_name", "")
        out["host_api"] = getattr(mic, "host_api", "")
        mic.close()
    out["listened_ms"] = round((now() - t0) * 1000.0, 1)
    out["stream"] = stats
    out["audio"] = np.concatenate(collected) if collected else np.zeros(0, dtype=np.float32)
    return out


def run_smoke(args: argparse.Namespace, deps: Optional[Deps] = None,
              say: Callable[[str], None] = print) -> Dict[str, Any]:
    deps = deps or Deps()
    now = deps.now
    report: Dict[str, Any] = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ok": False, "checks": [], "warnings": [], "error": None, "conclusion": None,
    }

    def check(name: str, ok: bool, detail: str = "") -> bool:
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        say(f"  [{'ok' if ok else 'FAIL'}] {name}{' — ' + detail if detail else ''}")
        return bool(ok)

    def warn(text: str) -> None:
        report["warnings"].append(text)
        say(f"  [note] {text}")

    def conclude(code: str, text: str) -> None:
        if report["conclusion"] is None:
            report["conclusion"] = {"code": code, "text": text}

    try:
        # ------------------------------------------------------------ 1. devices
        say("Input devices:")
        listing = deps.list_devices(args.host_api)
        inputs = listing.get("inputs", [])
        configured = args.device or args.input_device or ""
        selected = None
        if configured:
            selected = next((d for d in inputs if d["name"] == configured), None) \
                or next((d for d in inputs if d["name"].startswith(configured) or configured.startswith(d["name"])), None)
        fell_back = bool(configured) and selected is None
        if selected is None:
            selected = next((d for d in inputs if d.get("is_default")), inputs[0] if inputs else None)
        for d in inputs:
            marks = [m for m, on in (("Windows default" if sys.platform == "win32" else "system default", d.get("is_default")),
                                     ("USED BY THE APPLICATION", selected is not None and d["index"] == selected["index"])) if on]
            say(f"  [{d['index']:>2}] {d['name']}  ({d.get('channels', '?')} ch, {int(d.get('default_samplerate', 0))} Hz)"
                f"{'  <- ' + ', '.join(marks) if marks else ''}")
        report["devices"] = {"host_api": listing.get("host_api"), "inputs": inputs}
        report["selection"] = {
            "configured": configured or "(empty = default input device of the host API)",
            "source": "--device override" if args.device else "application configuration (audio.inputDevice)",
            "device": selected["name"] if selected else None,
            "index": selected["index"] if selected else None,
            "device_channels": selected.get("channels") if selected else None,
            "device_default_samplerate": selected.get("default_samplerate") if selected else None,
            "host_api": listing.get("host_api"),
            "configured_device_missing": fell_back,
        }
        say(f"Host API: {listing.get('host_api')}")
        if not check("An input device is available", selected is not None,
                     f"{selected['name']} (index {selected['index']})" if selected else "no input devices in this host API"):
            conclude("no_input_device", "Windows reports no input device for this host API.")
            return report
        if fell_back:
            warn(f"The configured microphone '{configured}' does not exist any more; the application falls back to '{selected['name']}'.")
        if args.device:
            warn(f"Testing '{selected['name']}' because of --device; the application configuration is not changed.")

        # ------------------------------------------------------- 2. VAD and STT
        say("Loading Silero VAD and faster-whisper…")
        t0 = now()
        vad = deps.make_vad()
        vad_ms = (now() - t0) * 1000.0
        report["vad_load_ms"] = round(vad_ms, 1)
        check("Silero VAD loaded", True, f"{vad_ms:.0f} ms")
        t0 = now()
        stt = deps.make_stt(args)
        stt.load()
        stt_info = stt.describe()
        stt_load_ms = (now() - t0) * 1000.0
        report["stt_model"] = {**stt_info, "requested_device": args.stt_device, "requested_compute_type": args.compute_type,
                               "load_ms_total": round(stt_load_ms, 1)}
        check("faster-whisper loaded", True,
              f"{stt_info.get('model')} on {stt_info.get('device')} ({stt_info.get('compute_type')}), language {stt_info.get('language')}, {stt_load_ms:.0f} ms")
        for note in stt_info.get("notes") or []:
            warn(str(note))
        params = _vad_params(args)
        report["vad_params"] = {"threshold": params.threshold, "min_speech_ms": params.min_speech_ms,
                                "min_silence_ms": params.min_silence_ms, "speech_pad_ms": params.speech_pad_ms}

        # --------------------------------- 3. VAD + STT on a known recording
        # No microphone here: this separates "the models work on this PC" from
        # "the microphone delivers the user's voice".
        if args.self_check_wav and os.path.isfile(args.self_check_wav):
            say(f"Pipeline self-check with a known speech recording ({args.self_check_wav})…")
            known = read_wav_16k(args.self_check_wav)
            known = np.concatenate([np.zeros(SAMPLE_RATE // 2, dtype=np.float32), known, np.zeros(SAMPLE_RATE, dtype=np.float32)])
            seg = _segment(known, vad, params)
            entry: Dict[str, Any] = {"wav": os.path.abspath(args.self_check_wav), "audio_ms": round(len(known) * 1000.0 / SAMPLE_RATE, 1),
                                     "max_speech_prob": round(seg["max_prob"], 4), "segments": len(seg["segments"])}
            if seg["segments"]:
                entry["stt"] = _transcribe(stt, np.concatenate([s["audio"] for s in seg["segments"]]), args.language, now)
            report["self_check"] = entry
            text = entry.get("stt", {}).get("text", "")
            check("Self-check: VAD and Whisper recognize a known speech recording", bool(seg["segments"]) and bool(text.strip()),
                  f"{len(seg['segments'])} segment(s), highest speech probability {seg['max_prob']:.2f}; text: \"{text}\"")
        else:
            report["self_check"] = {"skipped": True}
            warn("Self-check without microphone skipped: no known recording (run tts_smoke.bat once; it writes artifacts/tmp/tts_smoke.wav).")

        # ------------------------------------------------------ 4. microphone
        say("")
        say(f"Microphone test: '{selected['name']}' — speak now, one sentence, for example:")
        say(f"    {args.sentence}")
        say(f"  (listening for at most {args.seconds:.0f} s; it stops by itself after your sentence)")
        vad.reset()
        seg = Segmenter(params)
        rows: List[Dict[str, Any]] = []       # one record per frame: probability, state before/after, events
        seg.trace = rows.append
        peaks: List[float] = []
        state = {"t_last_line": 0.0, "win_peak": 0.0, "win_prob": 0.0, "segment": None, "frame_index": 0}

        def describe(snap: Dict[str, Any]) -> str:
            if not snap["in_speech"]:
                return "listening"
            return f"candidate open ({snap['candidate_ms']:.0f} ms speech, {snap['silence_ms']:.0f} ms silence since)"

        def on_frame(frame: np.ndarray, elapsed: float) -> bool:
            p = float(vad(frame))
            peak = float(np.max(np.abs(frame))) if len(frame) else 0.0
            peaks.append(peak)
            state["frame_index"] += 1
            state["win_peak"] = max(state["win_peak"], peak)
            state["win_prob"] = max(state["win_prob"], p)
            t_ms = state["frame_index"] * FRAME_SAMPLES * 1000.0 / SAMPLE_RATE
            done = False
            for ev in seg.process(p, frame, t_ms):
                at = f"  {t_ms / 1000.0:6.3f} s  frame {state['frame_index'] - 1:>3}  p={p:.2f} "
                if ev["type"] == "speech_start":
                    say(f"{at} candidate OPENED (probability at or above {params.threshold})")
                elif ev["type"] == "speech_discarded":
                    say(f"{at} candidate DISCARDED: {ev['speech_ms']:.0f} ms of speech is below the {params.min_speech_ms:.0f} ms minimum — back to listening")
                elif ev["type"] == "speech_end":
                    state["segment"] = ev
                    say(f"{at} utterance COMPLETE: {ev['speech_ms']:.0f} ms of speech")
                    done = True
            if elapsed - state["t_last_line"] >= 1.0:
                state["t_last_line"] = elapsed
                say(f"  {elapsed:5.1f} s  level [{_meter(state['win_peak'])}] peak {state['win_peak']:.4f}  "
                    f"highest speech probability in this second {state['win_prob']:.2f}  state: {describe(seg.snapshot(t_ms))}")
                state["win_peak"] = 0.0
                state["win_prob"] = 0.0
            return done

        open_name = selected["name"] if (configured and not fell_back) else ""
        native_holder: Dict[str, Any] = {"rec": None, "error": None}

        def start_native() -> None:
            # the unconverted signal of the same device, recorded at the same time
            if args.no_native:
                return
            try:
                rec_native = deps.make_native()
                rec_native.open(open_name, args.host_api)
                native_holder["rec"] = rec_native
            except Exception as exc:  # diagnostics must not disturb the test itself
                native_holder["error"] = f"{type(exc).__name__}: {exc}"

        rec = _record(deps.make_input, open_name, args.host_api, args.seconds, on_frame, now, after_open=start_native)
        native_audio = None
        if native_holder["rec"] is not None:
            try:
                native_audio = native_holder["rec"].close()
            except Exception as exc:
                native_holder["error"] = f"{type(exc).__name__}: {exc}"
        audio = rec.pop("audio", np.zeros(0, dtype=np.float32))
        stream = rec.get("stream") or {}
        report["capture"] = rec
        say("")
        if not check("Input stream opened", rec["opened"],
                     rec["error"] or f"'{rec.get('device')}' via {rec.get('host_api')}, {SAMPLE_RATE} Hz, 1 channel, {FRAME_SAMPLES}-sample blocks, "
                                     f"input latency {stream.get('input_latency_ms', '?')} ms"
                                     + (f"; {'; '.join(rec['notes'])}" if rec.get("notes") else "")):
            conclude("stream_failed", f"The input stream could not be opened: {rec['error']}")
            return report
        if rec.get("device") and not _same_device(rec["device"], selected["name"]):
            warn(f"The stream was opened on '{rec['device']}', not on '{selected['name']}'.")

        frames = len(audio) // FRAME_SAMPLES
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        rms = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0.0
        signal = classify_signal(frames, peak)
        activity = _activity(audio)
        report["level"] = {"frames": frames, "samples": int(len(audio)), "seconds": round(len(audio) / SAMPLE_RATE, 2),
                           "callbacks": stream.get("callbacks"), "overflows": stream.get("overflows"),
                           "peak": round(peak, 5), "rms": round(rms, 5), "peak_dbfs": _dbfs(peak), "rms_dbfs": _dbfs(rms),
                           "clipped": bool(peak >= 0.999), "signal": signal, **activity}
        if args.wav and len(audio):
            write_wav(args.wav, audio, SAMPLE_RATE)
            report["wav"] = os.path.abspath(args.wav)
        got_frames = check("Audio frames received from the device", frames > 0,
                           f"{frames} frames ({len(audio) / SAMPLE_RATE:.1f} s of audio) in {stream.get('callbacks', '?')} driver callbacks")
        got_signal = got_frames and check(
            "Captured audio is not silent", signal == "ok",
            f"peak {peak:.4f} ({_dbfs(peak)}), RMS {rms:.4f} ({_dbfs(rms)})"
            + ("; every sample is zero" if peak == 0 else "; digital silence" if signal == "digital_silence" else "; far too quiet for speech" if signal == "very_quiet" else ""))
        if got_frames and activity["zero_share"] >= 0.25 and peak > 0:
            warn(f"{activity['zero_share']:.0%} of the captured samples are exact zeros: sound arrived only between "
                 f"{activity['first_sound_s']} s and {activity['last_sound_s']} s; the rest is digital silence "
                 "(a microphone that is gated or muted at the source delivers zeros while it is closed).")
        if report.get("wav"):
            say(f"  recording saved: {report['wav']}  (listen to it to hear what the application hears)")
        if report["level"]["clipped"]:
            warn("The signal reaches full scale (clipping); lower the input level.")

        # --- what the VAD and the segmenter did with it, from the per-frame trace
        segment = state["segment"]
        final = seg.snapshot(frames * FRAME_SAMPLES * 1000.0 / SAMPLE_RATE)
        probs = [r["prob"] for r in rows]
        over = sum(1 for q in probs if q >= params.threshold)
        max_prob = max(probs) if probs else 0.0
        candidates: List[Dict[str, Any]] = []
        transitions: List[Dict[str, Any]] = []
        for n, r in enumerate(rows):
            changed = r["before"]["in_speech"] != r["after"]["in_speech"]
            if r["events"] or changed:
                transitions.append({"frame": n, **r})
            for ev in r["events"]:
                if ev["type"] == "speech_start":
                    candidates.append({"start_ms": round(ev["t_speech_start"], 1), "speech_ms": None, "outcome": "open"})
                elif ev["type"] == "speech_discarded" and candidates:
                    candidates[-1].update(speech_ms=round(ev["speech_ms"], 1), outcome="discarded_too_short", decided_at_ms=round(r["t_ms"], 1))
                elif ev["type"] == "speech_end" and candidates:
                    candidates[-1].update(speech_ms=round(ev["speech_ms"], 1), outcome="completed", decided_at_ms=round(r["t_ms"], 1))
        if final["in_speech"] and candidates:
            candidates[-1].update(speech_ms=round(final["candidate_ms"], 1), outcome="open_when_listening_stopped",
                                  silence_ms=round(final["silence_ms"], 1))
        discarded = [c for c in candidates if c["outcome"] == "discarded_too_short"]
        report["vad"] = {
            "max_speech_prob": round(max_prob, 4), "frames_over_threshold": over, "threshold": params.threshold,
            "frame_ms": seg.frame_ms, "candidates": candidates,
            "speech_starts": len(candidates), "speech_ends": 1 if segment else 0, "discarded_short": len(discarded),
            "in_speech_when_listening_stopped": bool(final["in_speech"]), "final_state": final,
            "speech_start_ms": candidates[0]["start_ms"] if candidates else None,
            "speech_ms": round(segment["speech_ms"], 1) if segment else None,
            "segment_audio_ms": round(len(segment["audio"]) * 1000.0 / SAMPLE_RATE, 1) if segment else None,
            "end_detected_after_silence_ms": round(segment["t_vad_end_detected"] - segment["t_speech_end"], 1) if segment else None,
            "transitions": transitions,
            "frame_probs": [round(q, 3) for q in probs],
            "frame_peaks": [round(q, 4) for q in peaks],
        }
        listed = "; ".join(f"{c['speech_ms']:.0f} ms ({c['outcome'].replace('_', ' ')})" for c in candidates if c["speech_ms"] is not None)
        no_utterance: Optional[str] = None
        if got_signal:
            saw = check("Silero VAD saw speech (a frame at or above the threshold)", over > 0,
                        f"highest speech probability {max_prob:.2f} (threshold {params.threshold}); {over} of {frames} frame(s) at or above it")
            long_enough = segment is not None or (final["in_speech"] and final["candidate_ms"] >= params.min_speech_ms)
            if saw:
                check(f"A speech candidate lasted at least {params.min_speech_ms:.0f} ms", long_enough,
                      f"{len(candidates)} candidate(s): {listed}")
            if long_enough:
                check("End of speech detected", segment is not None,
                      f"{segment['speech_ms']:.0f} ms of speech" if segment else
                      f"a candidate with {final['candidate_ms']:.0f} ms of speech was still open when listening stopped after {args.seconds:.0f} s")
            if segment is not None:
                check("Audio segment sent to faster-whisper", len(segment["audio"]) > 0, f"{len(segment['audio']) * 1000.0 / SAMPLE_RATE:.0f} ms of audio")
                result = _transcribe(stt, segment["audio"], args.language, now)
                report["stt"] = result
                has_text = check("faster-whisper returned text", bool(result["text"].strip()),
                                 f"\"{result['text']}\"  ({result['stt_ms']:.0f} ms, avg log-prob {result['avg_logprob']}, no-speech prob {result['no_speech_prob']})")
                if has_text:
                    check("The application would accept this transcript", result["accepted"], result["filter"])
                    check(f"Recognized text is in the conversation language ({args.language})", _has_letters_of(result["text"], args.language))
                    if result["accepted"]:
                        conclude("ok", f"The microphone '{rec.get('device')}' delivers speech and it is recognized: \"{result['text']}\"")
                    else:
                        conclude("stt_discarded", f"Whisper returned \"{result['text']}\", which the application discards ({result['filter']}).")
                else:
                    conclude("stt_no_text", "Speech was detected and sent to Whisper, but Whisper returned no text.")
            elif final["in_speech"]:
                no_utterance = "speech_not_finished"
                conclude("speech_not_finished",
                         f"A speech candidate was still open when listening stopped after {args.seconds:.0f} s "
                         f"({final['candidate_ms']:.0f} ms of speech, {final['silence_ms']:.0f} ms of silence since): the end of speech was not reached in time.")
            elif saw:
                no_utterance = "only_short_sounds"
                longest = max((c["speech_ms"] for c in discarded), default=0.0)
                conclude("only_short_sounds",
                         f"{len(discarded)} sound(s) reached the VAD threshold, the longest for {longest:.0f} ms, below the "
                         f"{params.min_speech_ms:.0f} ms minimum. Each was discarded and the segmenter went back to listening "
                         f"(it was not in speech when listening stopped). No utterance in {len(audio) / SAMPLE_RATE:.0f} s: "
                         f"{over} of {frames} frames reached the threshold, so the captured audio does not contain sustained speech.")
            else:
                no_utterance = "no_speech_detected"
                conclude("no_speech_detected",
                         f"The device delivers sound (peak {peak:.3f}) but no frame reached the VAD threshold (highest probability {max_prob:.2f}).")
            if no_utterance:
                # diagnostic only: does Whisper hear words in the recording?
                whole = _transcribe(stt, audio, args.language, now)
                report["whisper_on_whole_recording_diagnostic"] = whole
                say(f"  diagnostic: Whisper on the whole recording (not a result): \"{whole['text']}\"")
                say("  Listen to the saved recording: is your voice in it?")
        elif got_frames:
            if signal == "digital_silence":
                conclude("digital_silence",
                         f"The selected device '{rec.get('device')}' is open and delivers frames, but they contain only digital silence during this run: "
                         "muted or gated at the source, inactive, or microphone access for desktop apps is switched off in Windows "
                         "(Settings → Privacy & security → Microphone).")
            else:
                conclude("too_quiet", f"The selected device '{rec.get('device')}' delivers an extremely quiet signal (peak {peak:.4f}); speech cannot be detected at this level.")
        else:
            conclude("no_frames", f"The stream on '{rec.get('device')}' opened, but the driver delivered no audio frames in {args.seconds:.0f} s.")

        # ---- 5. the same device, unconverted, at the same time (diagnostic only)
        if native_holder["error"]:
            report["native_capture"] = {"recorded": False, "error": native_holder["error"]}
            warn(f"The device's native signal could not be recorded alongside: {native_holder['error']}")
        elif native_audio is not None:
            nrec = native_holder["rec"]
            say("")
            say(f"The same device in its own format, recorded at the same time ({nrec.sample_rate} Hz, {nrec.channels} channel(s)) — diagnostic only:")
            analysis, native_segments = _analyze_native(native_audio, nrec.sample_rate, vad, params)
            report["native_capture"] = {"recorded": True, "sample_rate": nrec.sample_rate, "channels": nrec.channels, **analysis}
            for v in analysis["variants"]:
                say(f"  {v['name']:<26} peak {v['peak']:.4f}  RMS {v['rms']:.5f}  zeros {v['zero_share']:.0%}  "
                    f"highest speech probability {v['max_speech_prob']:.2f}  frames at/above threshold {v['frames_over_threshold']}  utterances {v['utterances']}")
            if analysis.get("channel_correlation") is not None:
                say(f"  correlation between channel 1 and channel 2: {analysis['channel_correlation']:+.3f}"
                    + ("  (opposite phase: a mono mix cancels the signal)" if analysis["channel_correlation"] < -0.5 else ""))
            if args.native_wav and len(native_audio):
                write_wav(args.native_wav, native_audio, nrec.sample_rate)
                report["native_capture"]["wav"] = os.path.abspath(args.native_wav)
                say(f"  native recording saved: {report['native_capture']['wav']}")
            if no_utterance or not got_signal:
                with_speech = [v for v in analysis["variants"] if v["utterances"] > 0]
                if with_speech:
                    best = with_speech[0]
                    text = _transcribe(stt, native_segments[best["name"]], args.language, now)
                    report["native_capture"]["whisper_diagnostic"] = {"variant": best["name"], **text}
                    say(f"  SPEECH IS PRESENT in the native signal ({best['name']}): Whisper hears \"{text['text']}\"")
                    report["conclusion"]["text"] += (f" But the device's native signal recorded at the same time DOES contain an utterance ({best['name']}): "
                                                    "the voice is lost between the device and the application's 16 kHz mono capture.")
                    report["conclusion"]["native_signal_has_speech"] = True
                else:
                    best_prob = max((v["max_speech_prob"] for v in analysis["variants"]), default=0.0)
                    say("  No utterance in the native signal either.")
                    report["conclusion"]["text"] += (f" The device's native signal recorded at the same time ({nrec.sample_rate} Hz, {nrec.channels} channel(s)) "
                                                    f"contains no utterance either (highest speech probability {best_prob:.2f}): "
                                                    "the conversion to 16 kHz mono is not what removed it; the device's own signal "
                                                    "has no detectable speech in this run.")
                    report["conclusion"]["native_signal_has_speech"] = False

        # ---- 6. levels of the other input devices (measurement only; nothing is changed)
        if not got_signal and not args.no_scan:
            others = [d for d in inputs if d["index"] != selected["index"]]
            if others:
                say("")
                say(f"Measuring the other input devices for comparison ({args.scan_seconds:.0f} s each) — please KEEP TALKING…")
                scan = []
                for d in others:
                    r = _record(deps.make_input, d["name"], args.host_api, args.scan_seconds, None, now)
                    a = r.pop("audio", np.zeros(0, dtype=np.float32))
                    p = float(np.max(np.abs(a))) if len(a) else 0.0
                    q = float(np.sqrt(np.mean(np.square(a)))) if len(a) else 0.0
                    # the application's open() falls back to another device when one cannot be
                    # opened; a measurement only counts if THIS device was opened
                    this_one = r["opened"] and _same_device(r.get("device", ""), d["name"])
                    problem = r.get("error") or (None if this_one else f"opened '{r.get('device')}' instead")
                    entry = {"device": d["name"], "index": d["index"], "opened": bool(this_one), "error": problem,
                             "frames": len(a) // FRAME_SAMPLES if this_one else 0,
                             "peak": round(p, 5) if this_one else None, "rms": round(q, 5) if this_one else None,
                             "signal": classify_signal(len(a) // FRAME_SAMPLES, p) if this_one else "not_opened"}
                    scan.append(entry)
                    say(f"  [{d['index']:>2}] {d['name']}: " + (f"peak {p:.4f} ({_dbfs(p)}), RMS {q:.4f} → {entry['signal']}" if this_one else f"could not be measured ({problem})"))
                report["scan"] = scan
                live = [e for e in scan if e["signal"] == "ok"]
                say("  (comparison only: the selected microphone and all settings are unchanged)")
                if live:
                    report["conclusion"]["text"] += f" For comparison, a signal was measured on: {', '.join(e['device'] for e in live)}. Nothing was changed."
                else:
                    report["conclusion"]["text"] += " No other input device carried a signal during the comparison."
    except Exception as exc:
        import traceback
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
        check("Smoke test ran without an exception", False, report["error"])
        conclude("error", report["error"])

    report["ok"] = report["error"] is None and bool(report["checks"]) and all(c["ok"] for c in report["checks"])
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input-device", default="", help="microphone name from the application configuration (empty = default)")
    parser.add_argument("--device", default="", help="test this input device instead (the configuration is not changed)")
    parser.add_argument("--host-api", default="auto")
    parser.add_argument("--seconds", type=float, default=15.0)
    parser.add_argument("--scan-seconds", type=float, default=2.5)
    parser.add_argument("--no-scan", action="store_true")
    parser.add_argument("--no-native", action="store_true", help="do not record the device's native signal alongside")
    parser.add_argument("--native-wav", default=os.path.join("artifacts", "tmp", "mic_smoke_native.wav"))
    parser.add_argument("--stt-model", default="small")
    parser.add_argument("--stt-device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--language", default="ru")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--models-dir", default="models")
    parser.add_argument("--vad-threshold", type=float, default=0.5)
    parser.add_argument("--min-speech-ms", type=float, default=250.0)
    parser.add_argument("--min-silence-ms", type=float, default=600.0)
    parser.add_argument("--speech-pad-ms", type=float, default=200.0)
    parser.add_argument("--max-utterance-sec", type=float, default=30.0)
    parser.add_argument("--sentence", default=DEFAULT_SENTENCE)
    parser.add_argument("--self-check-wav", default=os.path.join("artifacts", "tmp", "tts_smoke.wav"))
    parser.add_argument("--wav", default=os.path.join("artifacts", "tmp", "mic_smoke.wav"))
    parser.add_argument("--report", default=os.path.join("artifacts", "reports", "mic_smoke.json"))
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    report = run_smoke(args)
    os.makedirs(os.path.dirname(args.report) or ".", exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    print("")
    sel = report.get("selection") or {}
    lvl = report.get("level") or {}
    vad = report.get("vad") or {}
    stt = report.get("stt") or {}
    print(f"Microphone:   {sel.get('device')}  (index {sel.get('index')}, {sel.get('host_api')}; {sel.get('source')})")
    if lvl:
        print(f"Captured:     {lvl.get('frames')} frames, {lvl.get('seconds')} s, peak {lvl.get('peak')} ({lvl.get('peak_dbfs')}), RMS {lvl.get('rms')} ({lvl.get('rms_dbfs')}) → {lvl.get('signal')}")
    if vad:
        print(f"VAD:          highest speech probability {vad.get('max_speech_prob')}; {vad.get('frames_over_threshold')} frame(s) at/above the threshold; "
              f"candidates opened {vad.get('speech_starts')}, discarded as too short {vad.get('discarded_short')}, utterances completed {vad.get('speech_ends')}; "
              f"in speech when listening stopped: {'yes' if vad.get('in_speech_when_listening_stopped') else 'no'}")
    if stt:
        print(f"Whisper:      \"{stt.get('text')}\"  ({stt.get('stt_ms')} ms for {stt.get('audio_ms')} ms of audio)")
    if report.get("conclusion"):
        print(f"Conclusion:   [{report['conclusion']['code']}] {report['conclusion']['text']}")
    print(f"RESULT: {'PASS' if report['ok'] else 'FAIL'}")
    print(f"Report: {os.path.abspath(args.report)}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
