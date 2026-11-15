"""Typed view of the configuration sent by the application core.

The conversation language is decided once in the core (conversation.language)
and arrives here already fanned out: stt.language, tts.language, tts.modelId
and tts.voice all belong to the same language pack.
"""
from dataclasses import dataclass, field
from typing import Any, Dict


def _num(value: Any, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    return v if v == v else default  # NaN guard


@dataclass(frozen=True)
class SttSettings:
    model: str = "small"
    device: str = "cuda"
    compute_type: str = "float16"
    language: str = "ru"
    beam_size: int = 5

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "SttSettings":
        d = d or {}
        return SttSettings(
            model=str(d.get("model") or "small"),
            device=str(d.get("device") or "cuda"),
            compute_type=str(d.get("computeType") or "float16"),
            language=str(d.get("language") or "ru"),
            beam_size=int(_num(d.get("beamSize"), 5)),
        )


@dataclass(frozen=True)
class TtsSettings:
    model_id: str = "v5_5_ru"
    voice: str = "xenia"
    device: str = "cpu"
    threads: int = 4
    sample_rate: int = 48000
    language: str = "ru"

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "TtsSettings":
        d = d or {}
        return TtsSettings(
            model_id=str(d.get("modelId") or "v5_5_ru"),
            voice=str(d.get("voice") or "xenia"),
            device=str(d.get("device") or "cpu"),
            threads=int(_num(d.get("threads"), 4)),
            sample_rate=int(_num(d.get("sampleRate"), 48000)),
            language=str(d.get("language") or "ru"),
        )


@dataclass(frozen=True)
class VadSettings:
    threshold: float = 0.5
    min_speech_ms: float = 250.0
    min_silence_ms: float = 600.0
    speech_pad_ms: float = 200.0
    max_utterance_ms: float = 30000.0

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "VadSettings":
        d = d or {}
        return VadSettings(
            threshold=_num(d.get("threshold"), 0.5),
            min_speech_ms=_num(d.get("minSpeechMs"), 250.0),
            min_silence_ms=_num(d.get("minSilenceMs"), 600.0),
            speech_pad_ms=_num(d.get("speechPadMs"), 200.0),
            max_utterance_ms=_num(d.get("maxUtteranceSec"), 30.0) * 1000.0,
        )


@dataclass(frozen=True)
class AudioSettings:
    host_api: str = "auto"
    input_device: str = ""
    output_device: str = ""
    listen_resume_delay_ms: float = 250.0

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "AudioSettings":
        d = d or {}
        return AudioSettings(
            host_api=str(d.get("hostApi") or "auto"),
            input_device=str(d.get("inputDevice") or ""),
            output_device=str(d.get("outputDevice") or ""),
            listen_resume_delay_ms=_num(d.get("listenResumeDelayMs"), 250.0),
        )


@dataclass(frozen=True)
class Settings:
    stt: SttSettings = field(default_factory=SttSettings)
    tts: TtsSettings = field(default_factory=TtsSettings)
    vad: VadSettings = field(default_factory=VadSettings)
    audio: AudioSettings = field(default_factory=AudioSettings)
    models_dir: str = "models"

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Settings":
        d = d or {}
        paths = d.get("paths") or {}
        return Settings(
            stt=SttSettings.from_dict(d.get("stt")),
            tts=TtsSettings.from_dict(d.get("tts")),
            vad=VadSettings.from_dict(d.get("vad")),
            audio=AudioSettings.from_dict(d.get("audio")),
            models_dir=str(paths.get("models_dir") or "models"),
        )
