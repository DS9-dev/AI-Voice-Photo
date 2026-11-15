"""Silero VAD (v5/v6 ONNX) wrapper using onnxruntime + numpy only.

The ONNX file ships inside the `silero-vad` pip package. It is located
without importing that package, because importing it pulls in torch, which
this code path does not need.
"""
import importlib.util
import os
from typing import Optional

import numpy as np

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512    # the model accepts exactly 512 samples at 16 kHz
CONTEXT_SAMPLES = 64


def find_model_path() -> str:
    override = os.environ.get("VVC_SILERO_VAD_ONNX")
    if override:
        if not os.path.isfile(override):
            raise FileNotFoundError(f"VVC_SILERO_VAD_ONNX points to a missing file: {override}")
        return override
    spec = importlib.util.find_spec("silero_vad")
    if spec is None or not spec.submodule_search_locations:
        raise ImportError("The 'silero-vad' package is not installed (pip install silero-vad)")
    for base in spec.submodule_search_locations:
        candidate = os.path.join(base, "data", "silero_vad.onnx")
        if os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError("silero_vad.onnx not found inside the silero-vad package")


class SileroVadOnnx:
    """Stateful frame classifier: call with 512 float32 samples, get P(speech)."""

    def __init__(self, model_path: Optional[str] = None):
        import onnxruntime as ort

        self.model_path = model_path or find_model_path()
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 3
        self._session = ort.InferenceSession(self.model_path, sess_options=opts, providers=["CPUExecutionProvider"])
        self._sr = np.array(SAMPLE_RATE, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, CONTEXT_SAMPLES), dtype=np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        if frame.shape[-1] != FRAME_SAMPLES:
            raise ValueError(f"Silero VAD needs {FRAME_SAMPLES} samples per frame, got {frame.shape[-1]}")
        x = np.concatenate([self._context, frame.reshape(1, -1).astype(np.float32, copy=False)], axis=1)
        out, state = self._session.run(None, {"input": x, "state": self._state, "sr": self._sr})
        self._state = state
        self._context = x[:, -CONTEXT_SAMPLES:]
        return float(np.asarray(out).reshape(-1)[0])
