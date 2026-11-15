"""Runs the real Silero VAD ONNX model when it is installed.

Skipped (not passed) when the model file is unavailable. The speech test
needs a 16-bit WAV with real speech: VVC_TEST_SPEECH_WAV, or the recording
that tts_smoke.bat leaves in artifacts/tmp/tts_smoke.wav (any sample rate).
"""
import os
import unittest

import numpy as np

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _speech_wav():
    for path in (os.environ.get("VVC_TEST_SPEECH_WAV"), os.path.join(_ROOT, "artifacts", "tmp", "tts_smoke.wav")):
        if path and os.path.isfile(path):
            return path
    return None

try:
    from services.voice_service.vad.silero_onnx import FRAME_SAMPLES, SileroVadOnnx, find_model_path
    MODEL_PATH = find_model_path()
except Exception as exc:  # onnxruntime or silero-vad missing
    MODEL_PATH = None
    SKIP_REASON = f"Silero VAD model not available: {exc}"
else:
    SKIP_REASON = ""


@unittest.skipIf(MODEL_PATH is None, SKIP_REASON)
class RealSileroVadTest(unittest.TestCase):
    def test_silence_and_noise_are_not_speech(self):
        vad = SileroVadOnnx(MODEL_PATH)
        silence = [vad(np.zeros(FRAME_SAMPLES, dtype=np.float32)) for _ in range(30)]
        self.assertLess(max(silence), 0.2)
        vad.reset()
        rng = np.random.default_rng(0)
        noise = [vad((rng.standard_normal(FRAME_SAMPLES) * 0.01).astype(np.float32)) for _ in range(30)]
        self.assertLess(float(np.mean(noise)), 0.3)

    def test_rejects_wrong_frame_size(self):
        vad = SileroVadOnnx(MODEL_PATH)
        with self.assertRaises(ValueError):
            vad(np.zeros(400, dtype=np.float32))

    @unittest.skipUnless(_speech_wav(), "no speech recording: run tts_smoke.bat (writes artifacts/tmp/tts_smoke.wav) or set VVC_TEST_SPEECH_WAV")
    def test_real_speech_is_segmented(self):
        from services.voice_service.audio.wavio import read_wav_16k
        from services.voice_service.vad.segmenter import Segmenter, SegmenterParams
        audio = np.concatenate([np.zeros(8000, dtype=np.float32), read_wav_16k(_speech_wav()), np.zeros(16000, dtype=np.float32)])
        vad = SileroVadOnnx(MODEL_PATH)
        seg = Segmenter(SegmenterParams())
        ends = []
        probs = []
        for i in range(0, len(audio) - FRAME_SAMPLES + 1, FRAME_SAMPLES):
            frame = audio[i:i + FRAME_SAMPLES]
            p = vad(frame)
            probs.append(p)
            for ev in seg.process(p, frame, (i + FRAME_SAMPLES) * 1000.0 / 16000.0):
                if ev["type"] == "speech_end":
                    ends.append(ev)
        self.assertGreater(max(probs), 0.9)
        self.assertGreaterEqual(len(ends), 1)
        for ev in ends:
            self.assertGreaterEqual(ev["t_vad_end_detected"] - ev["t_speech_end"], 600.0 - 1e-6)


if __name__ == "__main__":
    unittest.main()
