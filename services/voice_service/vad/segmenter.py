"""Utterance segmentation on top of per-frame speech probabilities.

Pure logic (no audio device, no model) so it can be unit tested with
synthetic probabilities.

Definitions used for latency reporting:
  t_speech_start     start time of the first frame classified as speech
  t_speech_end       end time of the last frame that was still speech, i.e.
                     the moment the user actually stopped talking (as far as
                     the VAD can tell, resolution = one frame, 32 ms)
  t_vad_end_detected time at which end-of-speech was declared, which is
                     t_speech_end + min_silence_ms (+ up to one frame)
"""
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Deque, Dict, List, Optional

import numpy as np


@dataclass
class SegmenterParams:
    threshold: float = 0.5
    min_speech_ms: float = 250.0
    min_silence_ms: float = 600.0
    speech_pad_ms: float = 200.0
    max_utterance_ms: float = 30000.0

    @property
    def neg_threshold(self) -> float:
        # hysteresis, same convention as Silero's reference VADIterator
        return max(self.threshold - 0.15, 0.01)


class Segmenter:
    def __init__(self, params: SegmenterParams, sample_rate: int = 16000, frame_samples: int = 512):
        self.params = params
        self.sample_rate = sample_rate
        self.frame_samples = frame_samples
        self.frame_ms = frame_samples * 1000.0 / sample_rate
        self._pre_roll: Deque[np.ndarray] = deque()
        self._next_id = 1
        # Optional instrumentation: called once per processed frame with
        # {"t_ms", "prob", "before", "after", "events"}; before/after are
        # snapshot() dicts. None (the default) costs nothing.
        self.trace: Optional[Callable[[Dict[str, Any]], None]] = None
        self.reset()

    # -- configuration ------------------------------------------------------
    def set_params(self, params: SegmenterParams) -> None:
        self.params = params

    def _pre_roll_frames(self) -> int:
        return int(np.ceil(self.params.speech_pad_ms / self.frame_ms))

    # -- state --------------------------------------------------------------
    def reset(self) -> None:
        """Forget any utterance in progress and the pre-roll audio."""
        self._pre_roll.clear()
        self._in_speech = False
        self._frames: List[np.ndarray] = []
        self._frame_end_times: List[float] = []
        self._pre_count = 0
        self._utterance_id: Optional[int] = None
        self._t_speech_start = 0.0
        self._t_last_speech_end = 0.0

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    def snapshot(self, t_now: Optional[float] = None) -> Dict[str, Any]:
        """The complete utterance state, for diagnostics and tests.

        While no candidate is open every candidate field is None / 0: that is
        the "clean listening state".
          candidate_ms  speech so far: start of the first frame at or above the
                        threshold to the end of the last frame still counted
                        as speech (at or above the lower hysteresis threshold)
          silence_ms    time since that last speech frame, as of t_now
        """
        if not self._in_speech:
            return {"in_speech": False, "utterance_id": None, "candidate_start_ms": None, "candidate_ms": 0.0,
                    "silence_ms": 0.0, "frames_buffered": 0, "pre_roll_frames": len(self._pre_roll)}
        return {
            "in_speech": True,
            "utterance_id": self._utterance_id,
            "candidate_start_ms": self._t_speech_start,
            "candidate_ms": self._t_last_speech_end - self._t_speech_start,
            "silence_ms": 0.0 if t_now is None else max(0.0, t_now - self._t_last_speech_end),
            "frames_buffered": len(self._frames),
            "pre_roll_frames": len(self._pre_roll),
        }

    # -- processing ---------------------------------------------------------
    def process(self, prob: float, frame: np.ndarray, t_frame_end: float) -> List[Dict[str, Any]]:
        """Feed one frame; returns zero or more events."""
        if self.trace is None:
            return self._process(prob, frame, t_frame_end)
        before = self.snapshot(t_frame_end)
        events = self._process(prob, frame, t_frame_end)
        self.trace({"t_ms": t_frame_end, "prob": float(prob), "before": before, "after": self.snapshot(t_frame_end),
                    "events": [{k: v for k, v in ev.items() if k != "audio"} for ev in events]})
        return events

    def _process(self, prob: float, frame: np.ndarray, t_frame_end: float) -> List[Dict[str, Any]]:
        p = self.params
        events: List[Dict[str, Any]] = []
        t_frame_start = t_frame_end - self.frame_ms

        if not self._in_speech:
            if prob >= p.threshold:
                self._in_speech = True
                self._utterance_id = self._next_id
                self._next_id += 1
                self._t_speech_start = t_frame_start
                self._t_last_speech_end = t_frame_end
                self._frames = list(self._pre_roll)
                self._pre_count = len(self._frames)
                self._frame_end_times = [0.0] * self._pre_count
                self._frames.append(frame)
                self._frame_end_times.append(t_frame_end)
                self._pre_roll.clear()
                events.append({
                    "type": "speech_start",
                    "utterance_id": self._utterance_id,
                    "t_speech_start": self._t_speech_start,
                })
            else:
                self._pre_roll.append(frame)
                limit = self._pre_roll_frames()
                while len(self._pre_roll) > limit:
                    self._pre_roll.popleft()
            return events

        # in speech
        self._frames.append(frame)
        self._frame_end_times.append(t_frame_end)
        if prob >= p.neg_threshold:
            # still speech (or inside the hysteresis band)
            self._t_last_speech_end = t_frame_end

        silence_ms = t_frame_end - self._t_last_speech_end
        too_long = (t_frame_end - self._t_speech_start) >= p.max_utterance_ms
        if silence_ms >= p.min_silence_ms or too_long:
            events.append(self._finish(t_frame_end, forced=too_long and silence_ms < p.min_silence_ms))
        return events

    def _finish(self, t_now: float, forced: bool) -> Dict[str, Any]:
        p = self.params
        t_end = t_now if forced else self._t_last_speech_end
        speech_ms = t_end - self._t_speech_start
        utterance_id = self._utterance_id

        # keep audio up to the end of speech plus a little trailing padding
        keep_until = t_end + p.speech_pad_ms
        n = self._pre_count
        for t in self._frame_end_times[self._pre_count:]:
            if t <= keep_until + 1e-6:
                n += 1
            else:
                break
        audio = np.concatenate(self._frames[:n]) if n else np.zeros(0, dtype=np.float32)

        t_start = self._t_speech_start
        self.reset()

        if speech_ms < p.min_speech_ms and not forced:
            return {
                "type": "speech_discarded",
                "utterance_id": utterance_id,
                "reason": "too_short",
                "speech_ms": speech_ms,
            }
        return {
            "type": "speech_end",
            "utterance_id": utterance_id,
            "audio": audio.astype(np.float32, copy=False),
            "t_speech_start": t_start,
            "t_speech_end": t_end,
            "t_vad_end_detected": t_now,
            "speech_ms": speech_ms,
            "forced": forced,
        }
