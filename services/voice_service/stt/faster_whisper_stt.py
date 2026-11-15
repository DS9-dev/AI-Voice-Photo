"""faster-whisper STT provider."""
import glob
import os
import sys
import time
from typing import Any, Dict, List

import numpy as np

_DLLS_PREPARED = False


def prepare_cuda_dlls() -> List[str]:
    """Make cuBLAS/cuDNN DLLs visible to CTranslate2 on Windows.

    CTranslate2 needs CUDA 12 cuBLAS and cuDNN 9. The CUDA build of PyTorch
    installed for this project bundles both in torch/lib, so that directory
    is added to the DLL search path (plus pip 'nvidia-*' packages if present).
    """
    global _DLLS_PREPARED
    added: List[str] = []
    if _DLLS_PREPARED or sys.platform != "win32":
        return added
    _DLLS_PREPARED = True
    import importlib.util

    candidates: List[str] = []
    spec = importlib.util.find_spec("torch")
    if spec and spec.submodule_search_locations:
        candidates.append(os.path.join(list(spec.submodule_search_locations)[0], "lib"))
    nv = importlib.util.find_spec("nvidia")
    if nv and nv.submodule_search_locations:
        for base in nv.submodule_search_locations:
            candidates.extend(glob.glob(os.path.join(base, "*", "bin")))
    for path in candidates:
        if os.path.isdir(path):
            try:
                os.add_dll_directory(path)
            except OSError:
                continue
            os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")
            added.append(path)
    return added


class FasterWhisperStt:
    name = "faster-whisper"

    def __init__(self, model: str, device: str, compute_type: str, language: str, beam_size: int, models_dir: str):
        self.model_name = model
        self.requested_device = device
        self.requested_compute_type = compute_type
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self.beam_size = beam_size
        self.models_dir = models_dir
        self.model = None
        self.notes: List[str] = []
        self.load_ms = 0.0
        self.warmup_ms = 0.0

    def load(self) -> None:
        prepare_cuda_dlls()
        from faster_whisper import WhisperModel

        download_root = os.path.join(self.models_dir, "whisper")
        os.makedirs(download_root, exist_ok=True)
        t0 = time.perf_counter()
        try:
            self.model = WhisperModel(self.model_name, device=self.requested_device,
                                      compute_type=self.requested_compute_type, download_root=download_root)
            self.device = self.requested_device
            self.compute_type = self.requested_compute_type
            self._warmup()
        except Exception as exc:
            if self.requested_device == "cpu":
                raise
            # Report the GPU failure visibly, then keep STT usable on CPU.
            self.notes.append(f"GPU STT failed ({type(exc).__name__}: {exc}); fell back to CPU int8")
            self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8",
                                      download_root=download_root)
            self.device = "cpu"
            self.compute_type = "int8"
            self._warmup()
        self.load_ms = (time.perf_counter() - t0) * 1000.0

    def _warmup(self) -> None:
        t0 = time.perf_counter()
        self.transcribe(np.zeros(16000, dtype=np.float32))
        self.warmup_ms = (time.perf_counter() - t0) * 1000.0

    def transcribe(self, audio: np.ndarray) -> Dict[str, Any]:
        """16 kHz mono float32 -> {'text', 'avg_logprob', 'no_speech_prob', 'language'}."""
        if self.model is None:
            raise RuntimeError("STT model is not loaded")
        segments, info = self.model.transcribe(
            audio,
            language=self.language or None,
            beam_size=self.beam_size,
            vad_filter=False,                   # segmentation is already done by Silero VAD
            condition_on_previous_text=False,   # utterances are independent
            without_timestamps=True,
        )
        texts: List[str] = []
        logprobs: List[float] = []
        no_speech: List[float] = []
        for seg in segments:                    # generator: inference happens here
            texts.append(seg.text)
            logprobs.append(float(seg.avg_logprob))
            no_speech.append(float(seg.no_speech_prob))
        return {
            "text": " ".join(t.strip() for t in texts).strip(),
            "avg_logprob": (sum(logprobs) / len(logprobs)) if logprobs else None,
            "no_speech_prob": max(no_speech) if no_speech else None,
            "language": getattr(info, "language", self.language),
        }

    def describe(self) -> dict:
        return {
            "provider": self.name,
            "model": self.model_name,
            "device": self.device,
            "compute_type": self.compute_type,
            "language": self.language,
            "beam_size": self.beam_size,
            "load_ms": round(self.load_ms, 1),
            "warmup_ms": round(self.warmup_ms, 1),
            "notes": self.notes,
        }
