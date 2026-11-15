"""Small WAV helpers for diagnostics and tests (16-bit PCM only, numpy + stdlib)."""
import io
import os
import wave
from typing import Tuple

import numpy as np

TARGET_RATE = 16000


def write_wav(path: str, audio: np.ndarray, sample_rate: int) -> None:
    """audio: (samples,) for mono or (samples, channels)."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    audio = np.asarray(audio)
    channels = 1 if audio.ndim == 1 else int(audio.shape[1])
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
    """Mono float32 [-1, 1] -> a complete 16-bit PCM WAV file in memory (no disk)."""
    pcm = (np.clip(np.asarray(audio, dtype=np.float32).reshape(-1), -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(pcm.tobytes())
    return buf.getvalue()


def read_wav(path: str) -> Tuple[np.ndarray, int]:
    """Mono float32 samples in [-1, 1] and the file's sample rate."""
    with wave.open(path, "rb") as wav:
        if wav.getsampwidth() != 2:
            raise ValueError(f"{path}: only 16-bit PCM WAV files are supported")
        rate = wav.getframerate()
        channels = wav.getnchannels()
        raw = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    if channels > 1:
        raw = raw.reshape(-1, channels).mean(axis=1)
    return (raw.astype(np.float32) / 32768.0), rate


def resample(audio: np.ndarray, rate: int, target: int = TARGET_RATE) -> np.ndarray:
    """Band-limited resampling good enough for speech diagnostics (not for playback)."""
    audio = np.asarray(audio, dtype=np.float32)
    if rate == target or len(audio) == 0:
        return audio
    ratio = rate / float(target)
    if ratio > 1.0:
        # low-pass below the new Nyquist frequency before dropping samples
        half = int(np.ceil(16 * ratio))
        n = np.arange(-half, half + 1)
        taps = np.sinc(n / ratio) * np.hamming(len(n))
        taps /= taps.sum()
        audio = np.convolve(audio, taps, mode="same")
    positions = np.arange(0, len(audio) - 1, ratio)
    return np.interp(positions, np.arange(len(audio)), audio).astype(np.float32)


def read_wav_16k(path: str) -> np.ndarray:
    audio, rate = read_wav(path)
    return resample(audio, rate, TARGET_RATE)
