"""In-memory fakes for the voice service engines (unit tests only).

These never count as evidence that the real models work.
"""
import io
import json
import threading
import time
from typing import Any, Dict, List

import numpy as np

from services.voice_service.protocol import Emitter
from services.voice_service.service import Factories


class CaptureStream(io.RawIOBase):
    """Collects emitted protocol lines and binary frames (VC-M3.2: "!<N> <json>\\n" + N bytes).

    A binary frame becomes its header dict with the raw bytes under "_payload".
    Writes may split a frame anywhere; the stream is decoded as bytes, like the core does.
    """

    def __init__(self):
        super().__init__()
        self._lock = threading.Lock()
        self.lines: List[Dict[str, Any]] = []
        self._buf = b""
        self._need = None   # (header, n) while a payload is pending

    def writable(self):
        return True

    def write(self, data):
        with self._lock:
            self._buf += bytes(data)
            while True:
                if self._need is not None:
                    header, n = self._need
                    if len(self._buf) < n:
                        break
                    header["_payload"] = self._buf[:n]
                    self._buf = self._buf[n:]
                    self._need = None
                    self.lines.append(header)
                    continue
                i = self._buf.find(b"\n")
                if i < 0:
                    break
                line, self._buf = self._buf[:i], self._buf[i + 1:]
                if line.startswith(b"!"):
                    size, _, js = line[1:].partition(b" ")
                    self._need = (json.loads(js.decode("utf-8")), int(size))
                elif line.strip():
                    self.lines.append(json.loads(line.decode("utf-8")))
        return len(data)

    def events(self, name=None):
        with self._lock:
            return [e for e in self.lines if name is None or e["event"] == name]

    def wait_for(self, predicate, timeout=3.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for e in self.events():
                if predicate(e):
                    return e
            time.sleep(0.005)
        raise AssertionError(f"timed out waiting for event; got {[e['event'] for e in self.events()]}")


class FakeVad:
    """P(speech) = 1 if the frame is loud, else 0."""

    def __init__(self):
        self.resets = 0

    def reset(self):
        self.resets += 1

    def __call__(self, frame):
        return 1.0 if float(np.max(np.abs(frame))) > 0.1 else 0.0


class FakeAudioIn:
    def __init__(self, on_frame):
        self.on_frame = on_frame
        self.device_name = "Fake Mic"
        self.host_api = "fake"
        self.latency_ms = 10.0
        self.closed = False

    def open(self, device_name, host_api_pref):
        return []

    def close(self):
        self.closed = True


class FakeAudioOut:
    """Plays instantly: start/end notifications fire as soon as audio is queued."""

    def __init__(self, sample_rate, on_event):
        self.sample_rate = sample_rate
        self.on_event = on_event
        self.device_name = "Fake Speakers"
        self.host_api = "fake"
        self.latency_ms = 20.0
        self.played = []
        self.hold = False
        self.held = []

    def open(self, device_name, host_api_pref):
        return []

    def play(self, data, tag):
        if self.hold:
            self.held.append((data, tag))
            return
        self._finish(data, tag)

    def _finish(self, data, tag):
        from services.voice_service.clock import now_ms
        self.played.append(tag)
        t = now_ms()
        self.on_event("start", tag, t)
        self.on_event("end", tag, t + len(data) * 1000.0 / self.sample_rate)

    def flush(self):
        dropped = [t for _, t in self.held]
        self.held = []
        return dropped

    def close(self):
        pass


class FakeStt:
    def __init__(self, text="привет как дела", fail=False, load_fail=False):
        self.text = text
        self.fail = fail
        self.load_fail = load_fail
        self.calls = 0
        self.language = "ru"

    def load(self):
        if self.load_fail:
            raise RuntimeError("cuda unavailable (fake)")

    def transcribe(self, audio):
        self.calls += 1
        if self.fail:
            raise RuntimeError("decode failed (fake)")
        return {"text": self.text, "avg_logprob": -0.2, "no_speech_prob": 0.01, "language": self.language}

    def describe(self):
        return {"provider": "fake", "model": "fake-small", "device": "cpu", "compute_type": "int8",
                "language": self.language, "notes": []}


class FakeTts:
    sample_rate = 48000

    def __init__(self, fail=False):
        self.fail = fail
        self.voice = "xenia"
        self.voices = ["xenia", "baya"]
        self.texts = []
        self.spoken = []  # (text, speaker actually used), in order
        self.language = "ru"

    def load(self):
        pass

    def set_voice(self, voice):
        if voice in self.voices:
            self.voice = voice
            return True
        return False

    def synthesize(self, text, voice=None):
        if self.fail:
            raise RuntimeError("synth failed (fake)")
        if voice and voice not in self.voices:
            raise ValueError(f"voice '{voice}' is not available in fake-tts (available: {', '.join(self.voices)})")
        self.texts.append(text)
        self.spoken.append((text, voice or self.voice))
        if not any(ch.isalpha() for ch in text):
            return np.zeros(0, dtype=np.float32)
        return np.full(4800, 0.1, dtype=np.float32)  # 100 ms

    def describe(self):
        return {"provider": "fake", "language": self.language, "model": "fake-tts", "voice": self.voice,
                "voices": self.voices, "device": "cpu", "sample_rate": self.sample_rate, "streaming": False,
                "notes": []}


class FakeFactories(Factories):
    def __init__(self, stt=None, tts=None, vad_fail=False):
        self.stt = stt or FakeStt()
        self.tts = tts or FakeTts()
        self.vad = FakeVad()
        self.vad_fail = vad_fail
        self.audio_in = None
        self.audio_out = None

    def make_vad(self):
        if self.vad_fail:
            raise RuntimeError("vad model missing (fake)")
        return self.vad

    def make_audio_in(self, on_frame):
        self.audio_in = FakeAudioIn(on_frame)
        return self.audio_in

    def make_audio_out(self, sample_rate, on_event):
        self.audio_out = FakeAudioOut(sample_rate, on_event)
        return self.audio_out

    def make_stt(self, s, models_dir):
        self.stt.language = s.language
        self.stt_settings = s
        return self.stt

    def make_tts(self, s, models_dir):
        self.tts.language = s.language
        self.tts_settings = s
        return self.tts

    def list_devices(self, host_api_pref):
        return {"host_api": "fake", "inputs": [{"index": 0, "name": "Fake Mic", "is_default": True}],
                "outputs": [{"index": 1, "name": "Fake Speakers", "is_default": True}]}

    def resources(self):
        return {"rss_mb": 123.0, "gpu": None}


def make_service(factories=None):
    from services.voice_service.service import VoiceService
    stream = CaptureStream()
    factories = factories or FakeFactories()
    service = VoiceService(Emitter(stream), factories)
    return service, stream, factories


LOUD = np.full(512, 0.5, dtype=np.float32)
QUIET = np.zeros(512, dtype=np.float32)
