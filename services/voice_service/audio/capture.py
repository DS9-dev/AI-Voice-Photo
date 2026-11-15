"""Microphone capture: 16 kHz mono float32 in 512-sample frames."""
import threading
from typing import Callable, List, Optional

import numpy as np

from ..clock import now_ms
from . import devices

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512


class FrameAssembler:
    """Re-chunks arbitrary block sizes into fixed frames (pure, unit tested)."""

    def __init__(self, frame_samples: int = FRAME_SAMPLES):
        self.frame_samples = frame_samples
        self._buf = np.zeros(0, dtype=np.float32)

    def reset(self) -> None:
        self._buf = np.zeros(0, dtype=np.float32)

    def push(self, block: np.ndarray, t_block_end_ms: float, sample_rate: int = SAMPLE_RATE):
        """Returns [(frame, t_frame_end_ms), ...]."""
        self._buf = np.concatenate([self._buf, block.astype(np.float32, copy=False)])
        out = []
        total = len(self._buf)
        n_frames = total // self.frame_samples
        for i in range(n_frames):
            start = i * self.frame_samples
            end = start + self.frame_samples
            # time of this frame's last sample relative to the block end
            remaining = total - end
            t_end = t_block_end_ms - remaining * 1000.0 / sample_rate
            out.append((self._buf[start:end].copy(), t_end))
        self._buf = self._buf[n_frames * self.frame_samples:]
        return out


class AudioInput:
    """Opens the microphone and delivers timestamped frames to a callback.

    Frame timestamps are the wall-clock time of the frame's last sample:
    callback time minus the input latency reported by the driver. This is an
    estimate; its error is bounded by driver latency reporting accuracy.
    """

    def __init__(self, on_frame: Callable[[np.ndarray, float], None]):
        self._on_frame = on_frame
        self._stream = None
        self._assembler = FrameAssembler()
        self._lock = threading.Lock()
        self.device_name = ""
        self.host_api = ""
        self.latency_ms = 0.0
        self.overflows = 0
        # facts about the opened stream and what it has delivered so far
        # (counted for every block from the driver, whether or not anyone listens)
        self.device_index: Optional[int] = None
        self.device_channels = 0
        self.device_default_samplerate = 0.0
        self.opened_at_ms = 0.0
        self.callbacks = 0
        self.samples = 0
        self.peak = 0.0
        self._sum_sq = 0.0
        self.status_flags = 0
        self.last_callback_ms = 0.0

    def open(self, device_name: str, host_api_pref: str) -> List[str]:
        """Open the stream. Returns notes about fallbacks that were needed."""
        import sounddevice as sd

        self.close()
        notes: List[str] = []
        attempts = [host_api_pref]
        if host_api_pref != "mme":
            attempts.append("mme")  # MME resamples for us if WASAPI refuses 16 kHz
        attempts.append("default")
        last_error: Optional[Exception] = None
        for pref in attempts:
            try:
                index, resolved, api = devices.resolve_device(device_name, "input", pref)
                if index is None:
                    raise RuntimeError("no input device available")
                stream = sd.InputStream(
                    device=index,
                    samplerate=SAMPLE_RATE,
                    channels=1,
                    dtype="float32",
                    blocksize=FRAME_SAMPLES,
                    latency="low",
                    callback=self._callback,
                    extra_settings=devices.stream_extra_settings(api),
                )
                self.callbacks = self.samples = self.status_flags = self.overflows = 0
                self.peak = self._sum_sq = 0.0
                self.latency_ms = float(stream.latency) * 1000.0
                self.opened_at_ms = now_ms()
                stream.start()
                self._stream = stream
                self.device_name = resolved
                self.host_api = api
                self.device_index = index
                try:
                    info = sd.query_devices(index)
                    self.device_channels = int(info.get("max_input_channels", 0))
                    self.device_default_samplerate = float(info.get("default_samplerate", 0.0))
                except Exception:
                    pass
                if device_name and resolved != device_name:
                    notes.append(f"Configured microphone '{device_name}' not found; using '{resolved}'")
                if pref != host_api_pref:
                    notes.append(f"Opened microphone through host API '{api}' after '{host_api_pref}' failed: {last_error}")
                return notes
            except Exception as exc:  # try the next host API
                last_error = exc
        raise RuntimeError(f"Cannot open microphone: {last_error}")

    def _callback(self, indata, frames, time_info, status) -> None:
        t_now = now_ms()
        if status:
            self.status_flags += 1
            if status.input_overflow:
                self.overflows += 1
        t_block_end = t_now - self.latency_ms
        block = indata[:, 0]
        self.callbacks += 1
        self.last_callback_ms = t_now
        if len(block):
            self.samples += len(block)
            peak = float(np.max(np.abs(block)))
            if peak > self.peak:
                self.peak = peak
            self._sum_sq += float(np.dot(block, block))
        for frame, t_end in self._assembler.push(block, t_block_end):
            self._on_frame(frame, t_end)

    def close(self) -> None:
        with self._lock:
            stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass
        self._assembler.reset()

    @property
    def active(self) -> bool:
        return self._stream is not None and self._stream.active

    def stats(self) -> dict:
        """What was opened and what the driver has delivered since then."""
        return {
            "device": self.device_name,
            "device_index": self.device_index,
            "host_api": self.host_api,
            "device_channels": self.device_channels,
            "device_default_samplerate": self.device_default_samplerate,
            "sample_rate": SAMPLE_RATE,
            "channels": 1,
            "block_samples": FRAME_SAMPLES,
            "input_latency_ms": round(self.latency_ms, 1),
            "stream_active": self.active,
            "open_ms": round(now_ms() - self.opened_at_ms, 1) if self.opened_at_ms else 0.0,
            "callbacks": self.callbacks,
            "samples": self.samples,
            "frames": self.samples // FRAME_SAMPLES,
            "peak": round(self.peak, 5),
            "rms": round(float(np.sqrt(self._sum_sq / self.samples)), 5) if self.samples else 0.0,
            "overflows": self.overflows,
            "status_flags": self.status_flags,
            "last_callback_age_ms": round(now_ms() - self.last_callback_ms, 1) if self.last_callback_ms else None,
        }


class NativeRecorder:
    """Records an input device in ITS OWN format: default sample rate, all channels.

    Diagnostics only (mic_smoke). The application always captures 16 kHz mono
    and lets the host API convert; recording the unconverted signal next to it
    tells "the conversion loses the voice" apart from "the device delivers no
    voice".
    """

    MAX_CHANNELS = 8

    def __init__(self):
        self._stream = None
        self._chunks: List[np.ndarray] = []
        self.device_name = ""
        self.host_api = ""
        self.sample_rate = 0
        self.channels = 0

    def open(self, device_name: str, host_api_pref: str) -> None:
        import sounddevice as sd

        index, resolved, api = devices.resolve_device(device_name, "input", host_api_pref)
        if index is None:
            raise RuntimeError("no input device available")
        info = sd.query_devices(index)
        self.sample_rate = int(round(float(info["default_samplerate"])))
        self.channels = max(1, min(self.MAX_CHANNELS, int(info["max_input_channels"])))
        self._chunks = []
        stream = sd.InputStream(device=index, samplerate=self.sample_rate, channels=self.channels,
                                dtype="float32", callback=self._callback)
        stream.start()
        self._stream = stream
        self.device_name = resolved
        self.host_api = api

    def _callback(self, indata, frames, time_info, status) -> None:
        self._chunks.append(indata.copy())

    def close(self) -> np.ndarray:
        """Stop and return what was recorded as (samples, channels)."""
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass
        if not self._chunks:
            return np.zeros((0, max(1, self.channels)), dtype=np.float32)
        return np.concatenate(self._chunks, axis=0)
