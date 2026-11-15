"""Silero TTS (Russian) provider.

Standalone use as documented by Silero: the model is a torch.package file
downloaded once into models/silero/ and loaded locally afterwards.

Synthesis is per text chunk: apply_tts() returns the complete waveform for
the chunk. There is no incremental audio streaming in this API.
"""
import os
import time
from typing import Any, Dict, List, Optional

import numpy as np

from . import model_store
from .model_store import MODEL_URL  # noqa: F401  (re-exported for callers)
from .text_normalize import normalizer_for, split_long

# Languages this provider can speak. The model id and the selected voice are
# chosen by the application core from its language pack; this table holds what
# the provider itself needs to know about a language.
LANGUAGES = {
    "ru": {
        "female_voices": ["xenia", "kseniya", "baya"],
        "male_voices": ["aidar", "eugene"],
        "warmup_text": "Привет, проверка голоса.",
        "apply_kwargs": {"put_accent": True, "put_yo": True},
    },
}


class SileroTts:
    name = "silero"
    streaming = False  # full-chunk synthesis only

    def __init__(self, model_id: str, voice: str, device: str, threads: int, sample_rate: int, models_dir: str,
                 language: str = "ru"):
        if language not in LANGUAGES:
            raise ValueError(f"Silero TTS provider has no configuration for language '{language}'")
        self.language = language
        self._lang = LANGUAGES[language]
        self._normalize, self._has_speakable = normalizer_for(language)
        self.model_id = model_id
        self.voice = voice
        self.requested_device = device
        self.device = device
        self.threads = threads
        self.sample_rate = sample_rate
        self.models_dir = models_dir
        self.model = None
        self.voices: List[str] = []
        self.notes: List[str] = []
        self.warmup_ms = 0.0
        self.load_ms = 0.0
        self.install: Dict[str, Any] = {}

    @property
    def model_path(self) -> str:
        return os.path.join(self.models_dir, "silero", f"{self.model_id}.pt")

    def ensure_downloaded(self) -> str:
        """Install the model file locally if needed (verified TLS, checked file)."""
        self.install = model_store.ensure_model(self.model_id, self.language, self.models_dir)
        return self.install["path"]

    def load(self) -> None:
        import torch

        path = self.ensure_downloaded()
        t_load = time.perf_counter()
        torch.set_num_threads(max(1, int(self.threads)))
        model = torch.package.PackageImporter(path).load_pickle("tts_models", "model")
        device = self.requested_device
        if device.startswith("cuda") and not torch.cuda.is_available():
            self.notes.append("CUDA requested for TTS but torch reports no CUDA device; using CPU")
            device = "cpu"
        model.to(torch.device(device))
        self.device = device
        self.model = model
        speakers = list(getattr(model, "speakers", []) or [])
        self.voices = [s for s in speakers if s != "random"] or self._lang["female_voices"] + self._lang["male_voices"]
        if self.voice not in self.voices:
            fallback = next((v for v in self._lang["female_voices"] if v in self.voices), self.voices[0])
            self.notes.append(f"Voice '{self.voice}' not available in {self.model_id}; using '{fallback}'")
            self.voice = fallback
        self.load_ms = (time.perf_counter() - t_load) * 1000.0
        t0 = time.perf_counter()
        self.synthesize(self._lang["warmup_text"])  # first call is slow (lazy init); do it now
        self.warmup_ms = (time.perf_counter() - t0) * 1000.0

    def set_voice(self, voice: str) -> bool:
        if voice in self.voices:
            self.voice = voice
            return True
        return False

    def speaker_for(self, voice: Optional[str] = None) -> str:
        """The speaker a synthesis will use: the configured voice, or the one
        named for this request. A named voice the model does not have is an
        error; it is never replaced by another voice."""
        if not voice:
            return self.voice
        if voice not in self.voices:
            raise ValueError(f"voice '{voice}' is not available in {self.model_id} (available: {', '.join(self.voices)})")
        return voice

    def synthesize(self, text: str, voice: Optional[str] = None) -> np.ndarray:
        """Text -> mono float32 waveform at self.sample_rate (may be empty).

        The speaker is passed to the model with every call: `voice` selects it
        for this call only, otherwise the configured voice is used. One loaded
        model serves all of its speakers; nothing is reloaded or cached per voice."""
        if self.model is None:
            raise RuntimeError("TTS model is not loaded")
        speaker = self.speaker_for(voice)
        clean = self._normalize(text)
        if not self._has_speakable(clean):
            return np.zeros(0, dtype=np.float32)
        pieces = []
        for part in split_long(clean):
            audio = self.model.apply_tts(
                text=part,
                speaker=speaker,
                sample_rate=self.sample_rate,
                **self._lang["apply_kwargs"],
            )
            pieces.append(audio.detach().cpu().numpy().astype(np.float32, copy=False).reshape(-1))
        if not pieces:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(pieces)

    def describe(self) -> dict:
        return {
            "provider": self.name,
            "language": self.language,
            "model": self.model_id,
            "voice": self.voice,
            "voices": self.voices,
            "female_voices": [v for v in self._lang["female_voices"] if v in self.voices],
            "device": self.device,
            "sample_rate": self.sample_rate,
            "streaming": self.streaming,
            "load_ms": round(self.load_ms, 1),
            "warmup_ms": round(self.warmup_ms, 1),
            "model_sha256": self.install.get("sha256"),
            "model_bytes": self.install.get("bytes"),
            "notes": self.notes,
        }
