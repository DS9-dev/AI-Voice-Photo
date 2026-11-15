"""Speaker output with playback-start / playback-end timestamps.

A single output stream stays open; synthesized chunks are queued and pulled
by the audio callback. Start/end notifications are timestamped inside the
callback as (callback wall time + offset inside the buffer + output latency)
and delivered from a separate thread so the callback never blocks on I/O.

The resulting "audible at" times are approximate: they rely on the output
latency reported by the audio driver.
"""
import queue
import threading
from collections import deque
from typing import Any, Callable, Deque, List, Optional

import numpy as np

from ..clock import now_ms
from . import devices


class PlaybackItem:
    __slots__ = ("data", "pos", "tag", "started")

    def __init__(self, data: np.ndarray, tag: Any):
        self.data = data
        self.pos = 0
        self.tag = tag
        self.started = False


class PlaybackQueue:
    """Device-independent queue + fill logic (unit tested without audio)."""

    def __init__(self, sample_rate: int):
        self.sample_rate = sample_rate
        self._items: Deque[PlaybackItem] = deque()
        self._lock = threading.Lock()

    def enqueue(self, data: np.ndarray, tag: Any) -> None:
        with self._lock:
            self._items.append(PlaybackItem(np.ascontiguousarray(data, dtype=np.float32), tag))

    def clear(self) -> List[Any]:
        """Drop everything; returns tags of the dropped items."""
        with self._lock:
            tags = [it.tag for it in self._items]
            self._items.clear()
        return tags

    def pending(self) -> int:
        with self._lock:
            return len(self._items)

    def fill(self, out: np.ndarray, t_buffer_start_ms: float, notify: Callable[[str, Any, float], None]) -> int:
        """Fill a mono float32 buffer; returns number of samples written.

        notify(kind, tag, t_ms) is called with kind 'start' / 'end'.
        t_buffer_start_ms is when out[0] will reach the speakers.
        """
        frames = len(out)
        filled = 0
        with self._lock:
            while filled < frames and self._items:
                item = self._items[0]
                if not item.started:
                    item.started = True
                    notify("start", item.tag, t_buffer_start_ms + filled * 1000.0 / self.sample_rate)
                n = min(frames - filled, len(item.data) - item.pos)
                out[filled:filled + n] = item.data[item.pos:item.pos + n]
                item.pos += n
                filled += n
                if item.pos >= len(item.data):
                    self._items.popleft()
                    notify("end", item.tag, t_buffer_start_ms + filled * 1000.0 / self.sample_rate)
        if filled < frames:
            out[filled:] = 0.0
        return filled


class AudioOutput:
    def __init__(self, sample_rate: int, on_event: Callable[[str, Any, float], None]):
        self.sample_rate = sample_rate
        self.queue = PlaybackQueue(sample_rate)
        self._on_event = on_event
        self._stream = None
        self._channels = 1
        self._events: "queue.Queue[Optional[tuple]]" = queue.Queue()
        self._notifier: Optional[threading.Thread] = None
        self.device_name = ""
        self.host_api = ""
        self.latency_ms = 0.0
        self.underflows = 0

    def open(self, device_name: str, host_api_pref: str) -> List[str]:
        import sounddevice as sd

        self.close()
        notes: List[str] = []
        attempts = [host_api_pref]
        if host_api_pref != "mme":
            attempts.append("mme")
        attempts.append("default")
        last_error: Optional[Exception] = None
        for pref in attempts:
            try:
                index, resolved, api = devices.resolve_device(device_name, "output", pref)
                if index is None:
                    raise RuntimeError("no output device available")
                max_ch = int(sd.query_devices(index)["max_output_channels"])
                channels = 2 if max_ch >= 2 else 1
                stream = sd.OutputStream(
                    device=index,
                    samplerate=self.sample_rate,
                    channels=channels,
                    dtype="float32",
                    latency="low",
                    callback=self._callback,
                    extra_settings=devices.stream_extra_settings(api),
                )
                self._channels = channels
                if self._notifier is None:
                    self._notifier = threading.Thread(target=self._notify_loop, name="playback-notify", daemon=True)
                    self._notifier.start()
                stream.start()
                self._stream = stream
                self.device_name = resolved
                self.host_api = api
                self.latency_ms = float(stream.latency) * 1000.0
                if device_name and resolved != device_name:
                    notes.append(f"Configured output '{device_name}' not found; using '{resolved}'")
                if pref != host_api_pref:
                    notes.append(f"Opened output through host API '{api}' after '{host_api_pref}' failed: {last_error}")
                return notes
            except Exception as exc:
                last_error = exc
        raise RuntimeError(f"Cannot open audio output: {last_error}")

    def _callback(self, outdata, frames, time_info, status) -> None:
        if status and status.output_underflow:
            self.underflows += 1
        delay_ms = self.latency_ms
        try:
            dac = float(time_info.outputBufferDacTime)
            cur = float(time_info.currentTime)
            if dac > 0 and cur > 0 and 0 <= (dac - cur) < 1.0:
                delay_ms = (dac - cur) * 1000.0
        except Exception:
            pass
        mono = outdata[:, 0]
        self.queue.fill(mono, now_ms() + delay_ms, self._queue_event)
        for ch in range(1, self._channels):
            outdata[:, ch] = mono

    def _queue_event(self, kind: str, tag: Any, t_ms: float) -> None:
        self._events.put((kind, tag, t_ms))

    def _notify_loop(self) -> None:
        while True:
            item = self._events.get()
            if item is None:
                return
            try:
                self._on_event(*item)
            except Exception:
                pass

    def play(self, data: np.ndarray, tag: Any) -> None:
        if self._stream is None:
            raise RuntimeError("audio output is not open")
        self.queue.enqueue(data, tag)

    def flush(self) -> List[Any]:
        return self.queue.clear()

    def close(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass
        if self._notifier is not None:
            self._events.put(None)
            self._notifier = None
        self.queue.clear()

    @property
    def active(self) -> bool:
        return self._stream is not None and self._stream.active
