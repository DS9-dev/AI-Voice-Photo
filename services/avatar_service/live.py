"""Endless Ditto stream with one timeline for audio and frames (AVP-04).

Ditto runs continuously: silence is fed while nobody speaks, the answer's speech is
placed on the same timeline when it arrives. The face never restarts, so speaking,
listening and silence flow into each other.

    timeline frame k  = 40 ms of audio (25 fps)
    feed position F   = next frame whose audio is handed to Ditto (runs ahead)
    heard position    = the timeline sample that is coming out of the speakers NOW,
                        from the audio device clock (PortAudio DAC time)
    frame k is shown when the heard position reaches k * 40 ms

So lips follow the sound that is actually played, including the output device latency;
no fixed offset is applied anywhere.
"""
import io
import math
import queue
import threading
import time
import wave
from typing import Any, Callable, Dict, List, Optional

import cv2
import numpy as np

FPS = 25
SR16 = 16000
HOP16 = SR16 // FPS          # 640 samples per frame for Ditto
CHUNK = (3, 5, 2)            # Ditto online chunk: 3 context, 5 current, 2 look-ahead frames
SPLIT_LEN = int(sum(CHUNK) * 0.04 * SR16) + 80   # 6480


class FrameSink:
    """Replaces Ditto's video writer: receives rendered frames with their timeline index."""

    def __init__(self, on_frame: Callable[[int, np.ndarray], None]):
        self.on_frame = on_frame
        self.n = 0

    def __call__(self, img, fmt="rgb", k=None):
        self.on_frame(self.n if k is None else k, img)
        self.n += 1

    def close(self):
        pass


class _NoTqdm:
    def __init__(self, *a, **k):
        pass

    def update(self, *a, **k):
        pass

    def close(self):
        pass


def make_live_sdk_class():
    """StreamSDK (online) with bounded buffers so it can run for hours."""
    import stream_pipeline_online as spo
    from stream_pipeline_online import StreamSDK, _mirror_index

    spo.tqdm = _NoTqdm  # Ditto's progress bars would flood stderr

    class LiveSDK(StreamSDK):
        def _audio2motion_worker(self):  # copy of Ditto's online worker + trimming of audio_feat
            is_end = False
            seq_frames = self.audio2motion.seq_frames
            valid_clip_len = self.audio2motion.valid_clip_len
            aud_feat_dim = self.wav2feat.feat_dim
            item_buffer = np.zeros((0, aud_feat_dim), dtype=np.float32)
            res_kp_seq = None
            res_kp_seq_valid_start = None
            global_idx = 0
            local_idx = 0
            gen_frame_idx = 0
            while not self.stop_event.is_set():
                try:
                    item = self.audio2motion_queue.get(timeout=1)
                except queue.Empty:
                    continue
                if item is None:
                    is_end = True
                else:
                    item_buffer = np.concatenate([item_buffer, item], 0)
                if not is_end and item_buffer.shape[0] < valid_clip_len:
                    continue
                self.audio_feat = np.concatenate([self.audio_feat, item_buffer], 0)
                item_buffer = np.zeros((0, aud_feat_dim), dtype=np.float32)
                while True:
                    aud_feat = self.audio_feat[local_idx: local_idx + seq_frames]
                    real_valid_len = valid_clip_len
                    if len(aud_feat) == 0:
                        break
                    elif len(aud_feat) < seq_frames:
                        if not is_end:
                            break
                        real_valid_len = len(aud_feat)
                        pad = np.stack([aud_feat[-1]] * (seq_frames - len(aud_feat)), 0)
                        aud_feat = np.concatenate([aud_feat, pad], 0)
                    aud_cond = self.condition_handler(aud_feat, global_idx + self.cond_idx_start)[None]
                    res_kp_seq = self.audio2motion(aud_cond, res_kp_seq)
                    if res_kp_seq_valid_start is None:
                        res_kp_seq_valid_start = res_kp_seq.shape[1] - self.audio2motion.fuse_length
                        self.motion_stitch.d0 = self.audio2motion.cvt_fmt(res_kp_seq[0:1])[0]
                        local_idx += real_valid_len
                        global_idx += real_valid_len
                        continue
                    valid = res_kp_seq[:, res_kp_seq_valid_start: res_kp_seq_valid_start + real_valid_len]
                    for x_d_info in self.audio2motion.cvt_fmt(valid):
                        frame_idx = _mirror_index(gen_frame_idx, self.source_info_frames)
                        ctrl_kwargs = self._get_ctrl_info(gen_frame_idx)
                        while not self.stop_event.is_set():
                            try:
                                self.motion_stitch_queue.put([frame_idx, x_d_info, ctrl_kwargs, gen_frame_idx], timeout=1)
                                break
                            except queue.Full:
                                continue
                        gen_frame_idx += 1
                    res_kp_seq_valid_start += real_valid_len
                    local_idx += real_valid_len
                    global_idx += real_valid_len
                    L = res_kp_seq.shape[1]
                    if L > seq_frames * 2:
                        cut = L - seq_frames * 2
                        res_kp_seq = res_kp_seq[:, cut:]
                        res_kp_seq_valid_start -= cut
                    # AVP-04: endless stream — drop audio features already behind the window
                    if local_idx > 4 * seq_frames:
                        self.audio_feat = self.audio_feat[local_idx:]
                        local_idx = 0
                    if local_idx >= len(self.audio_feat):
                        break
            if self.worker_exception is not None:
                raise self.worker_exception

        # ---- AVP-04: timeline index k travels with every frame. A frame that is already late for
        # its sound AND has a newer frame queued behind it is not rendered (warp, decoder, put-back
        # skipped): under GPU load the face shows the newest frame it can and catches up, instead of
        # drifting behind the voice. The newest frame is always rendered, so the face never
        # freezes. motion_stitch still runs for every frame (it advances the blink timing).
        due_fn = staticmethod(lambda: None)
        skipped = 0

        def _late(self, k):
            due = self.due_fn()
            return due is not None and k < due - 1

        def _stage(self, q_in, q_out, fn):
            while not self.stop_event.is_set():
                try:
                    item = q_in.get(timeout=1)
                except queue.Empty:
                    continue
                if item is None:
                    if q_out is not None:
                        q_out.put(None)
                    break
                out = fn(item)
                if q_out is not None and out is not None:
                    q_out.put(out)

        def _motion_stitch_worker(self):
            def fn(item):
                frame_idx, x_d_info, ctrl_kwargs, k = item
                x_s, x_d = self.motion_stitch(self.source_info["x_s_info_lst"][frame_idx], x_d_info, **ctrl_kwargs)
                return [frame_idx, x_s, x_d, k]
            self._stage(self.motion_stitch_queue, self.warp_f3d_queue, fn)

        def _warp_f3d_worker(self):
            def fn(item):
                frame_idx, x_s, x_d, k = item
                if self.warp_f3d_queue.qsize() > 0 and self._late(k):
                    self.skipped += 1
                    return [frame_idx, None, k]
                return [frame_idx, self.warp_f3d(self.source_info["f_s_lst"][frame_idx], x_s, x_d), k]
            self._stage(self.warp_f3d_queue, self.decode_f3d_queue, fn)

        def _decode_f3d_worker(self):
            def fn(item):
                frame_idx, f_3d, k = item
                if f_3d is None or (self.decode_f3d_queue.qsize() > 0 and self._late(k)):
                    return [frame_idx, None, k]
                return [frame_idx, self.decode_f3d(f_3d), k]
            self._stage(self.decode_f3d_queue, self.putback_queue, fn)

        def _putback_worker(self):
            def fn(item):
                frame_idx, render_img, k = item
                if render_img is None:
                    return None
                return [self.putback(self.source_info["img_rgb_lst"][frame_idx], render_img, self.source_info["M_c2o_lst"][frame_idx]), k]
            self._stage(self.putback_queue, self.writer_queue, fn)

        def _writer_worker(self):
            def fn(item):
                img, k = item
                self.writer(img, fmt="rgb", k=k)
            self._stage(self.writer_queue, None, fn)

    return LiveSDK, spo


class Segment:
    __slots__ = ("turn_id", "seq", "start", "a_out", "a16", "frames", "state", "t_arrived", "end_reason")

    def __init__(self, turn_id, seq, start, a_out, a16, frames, t_arrived):
        self.turn_id, self.seq, self.start = turn_id, seq, start
        self.a_out, self.a16, self.frames = a_out, a16, frames
        self.state = "queued"   # queued | playing | done
        self.t_arrived = t_arrived
        self.end_reason = None

    @property
    def end(self):
        return self.start + self.frames


def decode_wav(data: bytes):
    with wave.open(io.BytesIO(data), "rb") as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise ValueError("only 16-bit PCM WAV is supported")
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(1)
    return a, sr


class LipGate:
    """Per-frame lip alpha from the loudness of the frame's own audio (see accel.ctrl_vad_lips).
    Open at once (up to `lead` frames before the sound), close over `release` frames after it."""

    def __init__(self, threshold_db=-32.0, lead=2, release=3):
        self.threshold_db, self.lead, self.release = threshold_db, lead, release
        self.last_speech = -10 ** 9

    def alphas(self, f0, energies_db):
        """energies_db: frames f0 .. f0+n-1+lead (look-ahead included). Returns n alphas for f0.."""
        n = len(energies_db) - self.lead
        out = np.zeros(max(n, 0), dtype=np.float32)
        for i in range(n):
            if (energies_db[i:i + self.lead + 1] > self.threshold_db).any():
                self.last_speech = f0 + i
                out[i] = 1.0
            else:
                out[i] = max(0.0, 1.0 - (f0 + i - self.last_speech) / (self.release + 1))
        return out


class LiveAvatar:
    """Owns the endless Ditto stream, the audio output and the frame publisher."""

    def __init__(self, emit: Callable[..., None], log: Callable[[str, str], None],
                 out_rate=48000, ahead_frames=35, margin_frames=5, jpeg_quality=93):
        self.emit = emit
        self.log = log
        self.out_rate = out_rate
        self.out_hop = out_rate // FPS
        self.ahead = ahead_frames
        self.margin = margin_frames
        self.jpeg_quality = jpeg_quality
        self.gate = LipGate()
        self.lock = threading.RLock()
        self.sdk = None
        self.running = False
        self.photo = ""
        self.segments: List[Segment] = []
        self.frames: Dict[int, tuple] = {}
        self.frame_cv = threading.Condition()
        self.publish = None            # callable(jpeg_bytes, frame_index)
        self.stream = None
        self._threads: List[threading.Thread] = []
        self._stop = threading.Event()
        # clocks
        self.F = 0                      # next frame to feed
        self.offset = None              # device sample index of timeline sample 0 (None until first frame)
        self.dev_samples = 0            # samples written to the device since the stream opened
        self.anchor = None              # (timeline sample at block start, perf_counter when it is heard)
        self.out_latency_ms = 0.0
        self.shown = -1
        self.stats = {"frames_rendered": 0, "frames_shown": 0, "frames_repeated": 0, "frames_dropped": 0,
                      "late_events": 0, "offset_grow_events": 0, "render_fps": 0.0, "slack_ms": None,
                      "speech_delay_ms": None, "underflows": 0}
        self._render_times: List[float] = []
        self._level = 0.0
        self._last_level_emit = 0.0
        self._record = None

    # ------------------------------------------------------------ audio out --

    def open_output(self, device_name: str, host_api: str):
        import sounddevice as sd
        from services.voice_service.audio import devices
        self.close_output()
        notes = []
        last = None
        for pref in [host_api or "auto", "mme", "default"]:
            try:
                index, resolved, api = devices.resolve_device(device_name, "output", pref)
                if index is None:
                    raise RuntimeError("no output device")
                ch = 2 if int(sd.query_devices(index)["max_output_channels"]) >= 2 else 1
                st = sd.OutputStream(device=index, samplerate=self.out_rate, channels=ch, dtype="float32",
                                     latency="low", blocksize=self.out_hop // 2, callback=self._audio_cb,
                                     extra_settings=devices.stream_extra_settings(api))
                self._channels = ch
                st.start()
                self.stream = st
                self.out_latency_ms = float(st.latency) * 1000
                if device_name and resolved != device_name:
                    notes.append(f"Configured output '{device_name}' not found; using '{resolved}'")
                self.output_name = resolved
                return notes
            except Exception as exc:  # try the next host API
                last = exc
        raise RuntimeError(f"Cannot open audio output: {last}")

    def close_output(self):
        st, self.stream = self.stream, None
        if st is not None:
            try:
                st.stop()
                st.close()
            except Exception:
                pass

    def _audio_cb(self, outdata, frames, time_info, status):
        if status and status.output_underflow:
            self.stats["underflows"] += 1
        now = time.perf_counter()
        delay = self.out_latency_ms / 1000
        try:
            dac, cur = float(time_info.outputBufferDacTime), float(time_info.currentTime)
            if dac > 0 and cur > 0 and 0 <= dac - cur < 1.0:
                delay = dac - cur
        except Exception:
            pass
        self.out_latency_ms = delay * 1000
        mono = outdata[:, 0]
        mono[:] = 0
        off = self.offset
        if off is not None:
            t0 = self.dev_samples - off
            self.anchor = (t0, now + delay)
            self._mix(mono, t0)
        for c in range(1, getattr(self, "_channels", 1)):
            outdata[:, c] = mono
        self.dev_samples += frames

    def _mix(self, out, t0):
        """Write the timeline audio [t0, t0+len) into out."""
        n = len(out)
        hop = self.out_hop
        with self.lock:
            segs = list(self.segments)
        for s in segs:
            s0 = s.start * hop
            a = s.a_out
            lo, hi = max(t0, s0), min(t0 + n, s0 + len(a))
            if lo < hi:
                out[lo - t0:hi - t0] = a[lo - s0:hi - s0]
        if self._record is not None:
            self._record["audio"].append((t0, out.copy()))

    def heard_sample(self, t=None):
        a = self.anchor
        if a is None:
            return None
        t = time.perf_counter() if t is None else t
        return a[0] + (t - a[1]) * self.out_rate

    # -------------------------------------------------------------- photo --

    def start(self, photo: str, max_size: int, cfg_path: str, data_root: str, **setup_kwargs):
        self.stop()
        t0 = time.perf_counter()
        LiveSDK, spo = make_live_sdk_class()
        if self.sdk is None:
            self.sdk = LiveSDK(cfg_path, data_root)
        sink = FrameSink(self._on_frame)
        spo.VideoWriterByImageIO = lambda path, **kw: sink   # no video file: frames go to the sink
        self.sdk.setup(photo, "live", max_size=max_size, **setup_kwargs)
        self.sdk.due_fn = self._due_frame
        self.sdk.skipped = 0
        self.sdk.setup_Nd(N_d=-1, fade_in=-1, fade_out=-1, ctrl_info={})
        self.photo = photo
        with self.lock:
            self.segments = []
            self.F = 0
            self.offset = None
            self.shown = -1
            self.frames = {}
        self.gate = LipGate()
        self._stop.clear()
        self.running = True
        for fn, name in ((self._feeder, "feeder"), (self._display, "display")):
            th = threading.Thread(target=fn, name=name, daemon=True)
            th.start()
            self._threads.append(th)
        return round(time.perf_counter() - t0, 2)

    def stop(self):
        if not self.running:
            return
        self._stop.set()
        for th in self._threads:
            th.join(timeout=3)
        self._threads = []
        self.running = False
        try:
            self.sdk.stop_event.set()
            for th in getattr(self.sdk, "thread_list", []):
                th.join(timeout=5)
        except Exception:
            pass
        with self.frame_cv:
            self.frames = {}
        with self.lock:
            dropped = [s for s in self.segments if s.state != "done"]
            self.segments = []
        for s in dropped:
            self._end_segment(s, "dropped")

    # --------------------------------------------------------------- feed --

    def _timeline16(self, f0, f1, extra=0):
        """Ditto input audio for frames [f0, f1) (+extra samples), silence where nobody speaks."""
        n = (f1 - f0) * HOP16 + extra
        out = np.zeros(n, dtype=np.float32)
        t0 = f0 * HOP16
        with self.lock:
            segs = list(self.segments)
        for s in segs:
            s0 = s.start * HOP16
            a = s.a16
            lo, hi = max(t0, s0), min(t0 + n, s0 + len(a))
            if lo < hi:
                out[lo - t0:hi - t0] = a[lo - s0:hi - s0]
        return out

    def _due_frame(self):
        h = self.heard_sample()
        return None if h is None else int(math.floor(h / self.out_hop))

    def _feeder(self):
        sdk = self.sdk
        while not self._stop.is_set():
            due = self._due_frame()
            target = (due if due is not None else 0) + self.ahead
            if self.F >= target:
                time.sleep(0.005)
                continue
            F = self.F
            # chunk for current frames F..F+4: context F-3..F-1, look-ahead F+5..F+6 (+80 samples)
            audio = self._timeline16(F - CHUNK[0], F + CHUNK[1] + CHUNK[2], extra=80)
            frames16 = audio[:len(audio) - 80].reshape(-1, HOP16)
            energies = 20 * np.log10(np.sqrt((frames16.astype(np.float64) ** 2).mean(1)) + 1e-9)
            alphas = self.gate.alphas(F, energies[CHUNK[0]:])            # frames F..F+4 (+2 look-ahead)
            for i, a in enumerate(alphas[:CHUNK[1]]):
                if a < 1:
                    sdk.ctrl_info[F + i] = {"vad_alpha": float(a)}
            sdk.run_chunk(audio, CHUNK)
            with self.lock:
                self.F = F + CHUNK[1]
            # forget control entries far behind
            if F % 250 == 0:
                for k in [k for k in sdk.ctrl_info if k < F - 300]:
                    sdk.ctrl_info.pop(k, None)

    def _on_frame(self, k, rgb):
        now = time.perf_counter()
        with self.frame_cv:
            self.frames[k] = (rgb, now)
            self.frame_cv.notify_all()
        self.stats["frames_rendered"] += 1
        self._render_times.append(now)
        if len(self._render_times) > 50:
            self._render_times.pop(0)
        if self.offset is None:
            # the timeline starts when frame 0 exists: it is heard `margin` frames from now
            dev_now = self.dev_samples
            # timeline sample 0 is written to the device `margin` frames from now
            self.offset = dev_now + self.margin * self.out_hop
            self.log("info", "Avatar stream: first frame rendered, timeline started")
        h = self.heard_sample(now)
        if h is not None:
            slack = (k * self.out_hop - h) / self.out_rate * 1000
            self.stats["slack_ms"] = round(slack)

    # ------------------------------------------------------------ speech --

    def play(self, turn_id, seq, wav: bytes, t_arrived=None):
        a, sr = decode_wav(wav)
        if sr != self.out_rate:
            from scipy.signal import resample_poly
            g = math.gcd(sr, self.out_rate)
            a_out = resample_poly(a, self.out_rate // g, sr // g).astype(np.float32)
        else:
            a_out = a
        from scipy.signal import resample_poly
        g = math.gcd(sr, SR16)
        a16 = resample_poly(a, SR16 // g, sr // g).astype(np.float32)
        frames = int(math.ceil(len(a_out) / self.out_hop))
        with self.lock:
            # never into audio Ditto has already been given (+ look-ahead); right after the turn's previous chunk
            start = self.F + CHUNK[2] + 1
            for s in self.segments:
                if s.turn_id == turn_id and s.state != "done":
                    start = max(start, s.end)
            seg = Segment(turn_id, seq, start, a_out, a16, frames, t_arrived or time.perf_counter())
            self.segments.append(seg)
        return seg

    def stop_turn(self, turn_id, reason="stopped"):
        """Stop an answer: its unheard audio is removed and the lips close (frames not yet stitched)."""
        h = self.heard_sample()
        heard_frame = int(h // self.out_hop) if h is not None else 0
        ended = []
        with self.lock:
            keep = []
            for s in self.segments:
                if s.turn_id != turn_id or s.state == "done":
                    keep.append(s)
                    continue
                if s.start < heard_frame:
                    played = (heard_frame - s.start) * self.out_hop
                    s.a_out = s.a_out[:played]
                    s.a16 = s.a16[:(heard_frame - s.start) * HOP16]
                ended.append(s)
            self.segments = keep
        if self.sdk is not None:
            for k in range(heard_frame, self.F + CHUNK[2] + 1):
                self.sdk.ctrl_info[k] = {"vad_alpha": 0.0}
        for s in ended:
            self._end_segment(s, reason, heard_frame)
        return len(ended)

    def _end_segment(self, s, reason, heard_frame=None):
        if s.state == "done":
            return
        played = 0 if heard_frame is None else max(0, min(s.frames, heard_frame - s.start)) * 40
        s.state = "done"
        s.end_reason = reason
        self.emit("speech_ended", turn_id=s.turn_id, seq=s.seq, reason=reason, played_ms=played,
                  tail_ms=round(self.out_latency_ms))

    # ------------------------------------------------------------ display --

    def _display(self):
        while not self._stop.is_set():
            h = self.heard_sample()
            if h is None:
                time.sleep(0.01)
                continue
            k = int(math.floor(h / self.out_hop))
            self._speech_events(k)
            self._emit_level(h)
            if k > self.shown:
                self._show(k)
            # wake for the next frame boundary
            nxt = ((k + 1) * self.out_hop - h) / self.out_rate
            time.sleep(min(max(nxt, 0.002), 0.04))
        self.publish_frame(None, -1)

    def _show(self, k):
        with self.frame_cv:
            avail = [i for i in self.frames if i <= k]
            if not avail:
                self.stats["late_events"] += 1
                self._maybe_grow(k)
                return
            best = max(avail)
            rgb = self.frames[best][0]
            if best < k:
                self.stats["frames_repeated"] += 1
            skipped = len([i for i in avail if self.shown < i < best])
            self.stats["frames_dropped"] += skipped
            for i in [i for i in self.frames if i < best]:
                del self.frames[i]
        if best == self.shown:
            return
        self.shown = best
        self.stats["frames_shown"] += 1
        ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, self.jpeg_quality])
        if ok:
            self.publish_frame(jpg.tobytes(), best)
        if self._record is not None and len(self._record["frames"]) < 25 * 120:
            self._record["frames"].append((k, rgb))

    def _maybe_grow(self, k):
        """Frames are late. While nobody speaks, add 200 ms of silence to the buffer (never mid-speech)."""
        with self.lock:
            speaking = any(s.state != "done" and s.start <= k + 30 for s in self.segments)
            if speaking or self.offset is None:
                return
            self.offset += 5 * self.out_hop
            self.ahead += 2
        self.stats["offset_grow_events"] += 1

    def publish_frame(self, jpg, k):
        if self.publish:
            self.publish(jpg, k)

    def _speech_events(self, k):
        with self.lock:
            segs = list(self.segments)
        for s in segs:
            if s.state == "queued" and k >= s.start:
                s.state = "playing"
                delay = (time.perf_counter() - s.t_arrived) * 1000
                if s.seq in (0, None):   # later chunks also wait for the earlier ones: not a latency
                    self.stats["speech_delay_ms"] = round(delay)
                self.emit("speech_started", turn_id=s.turn_id, seq=s.seq, tail_ms=round(self.out_latency_ms),
                          delay_ms=round(delay))
            if s.state == "playing" and k >= s.end:
                self._end_segment(s, "completed", k)
                with self.lock:
                    if s in self.segments:
                        self.segments.remove(s)

    def _emit_level(self, h):
        """Loudness of the audio being heard now (for the ambient glow), ~25 updates/s."""
        now = time.perf_counter()
        if now - self._last_level_emit < 0.04:
            return
        i0 = int(h) - self.out_hop // 2
        win = np.zeros(self.out_hop, dtype=np.float32)
        with self.lock:
            segs = list(self.segments)
        for s in segs:
            s0 = s.start * self.out_hop
            lo, hi = max(i0, s0), min(i0 + self.out_hop, s0 + len(s.a_out))
            if lo < hi:
                win[lo - i0:hi - i0] = s.a_out[lo - s0:hi - s0]
        rms = float(np.sqrt(np.mean(win ** 2)))
        # AVP-04 fix 2: speech spans about -42..-15 dB per 40 ms; map that range onto 0..1
        # (the old -50..-10 dB scale kept speech near the top, so the glow hardly moved)
        lin = min(1.0, max(0.0, (20 * math.log10(rms + 1e-9) + 42) / 27))
        level = lin ** 1.3
        if abs(level - self._level) > 0.02 or (level > 0 and now - self._last_level_emit > 0.2) or now - self._last_level_emit > 1:
            self._level = level
            self._last_level_emit = now
            self.emit("level", level=round(level, 3))

    def info(self):
        rt = self._render_times
        fps = (len(rt) - 1) / (rt[-1] - rt[0]) if len(rt) > 2 and rt[-1] > rt[0] else 0.0
        self.stats["render_fps"] = round(fps, 1)
        d = dict(self.stats)
        d["frames_skipped_late"] = getattr(self.sdk, "skipped", 0) if self.sdk else 0
        d.update({"ahead_frames": self.ahead, "out_latency_ms": round(self.out_latency_ms),
                  "buffer_ms": round((self.F - (self._due_frame() or 0)) * 40) if self.anchor else None,
                  "segments": len(self.segments)})
        return d

    # ------------------------------------------------------------- record --

    def record_start(self):
        self._record = {"frames": [], "audio": []}

    def record_stop(self, path):
        rec, self._record = self._record, None
        if not rec or not rec["frames"]:
            return None
        import imageio
        k0 = rec["frames"][0][0]
        by_k = {k: img for k, img in rec["frames"]}
        last = rec["frames"][0][1]
        w = imageio.get_writer(path + "_video.mp4", fps=FPS, codec="libx264", quality=None,
                               ffmpeg_params=["-crf", "18", "-pix_fmt", "yuv420p"])
        for k in range(k0, rec["frames"][-1][0] + 1):
            last = by_k.get(k, last)
            w.append_data(last)
        w.close()
        # the played audio placed on the timeline, from frame k0 on (what the speakers got for those frames)
        n = (rec["frames"][-1][0] - k0 + 1) * self.out_hop
        audio = np.zeros(n, np.float32)
        base = k0 * self.out_hop
        for t0, chunk in rec["audio"]:
            lo, hi = max(t0, base), min(t0 + len(chunk), base + n)
            if lo < hi:
                audio[lo - base:hi - base] = chunk[lo - t0:hi - t0]
        with wave.open(path + "_audio.wav", "wb") as wv:
            wv.setnchannels(1)
            wv.setsampwidth(2)
            wv.setframerate(self.out_rate)
            wv.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
        return {"first_frame": k0, "frames": rec["frames"][-1][0] - k0 + 1}
