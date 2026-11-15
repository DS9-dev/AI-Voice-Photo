"""Decides whether a Whisper transcript is a real utterance.

Whisper tends to invent stock phrases on noise or near-silence (subtitle
credits and similar). Passing those to the LLM would create phantom turns.
"""
import re
from typing import Optional, Tuple

# Well-known Whisper hallucinations on audio without real speech, per language.
_HALLUCINATION_PATTERNS = {
    "ru": [
        r"субтитры\s+(с?делал|подготовил|создавал|подогнал)",
        r"редактор\s+субтитров",
        r"корректор\s+[А-ЯЁ]\.",
        r"продолжение\s+следует",
        r"спасибо\s+за\s+просмотр",
        r"подписывайтесь\s+на\s+(мой\s+|наш\s+)?канал",
        r"dimatorzok",
    ],
}
_HALLUCINATION_RE = {lang: re.compile("|".join(p), re.IGNORECASE) for lang, p in _HALLUCINATION_PATTERNS.items()}
_HAS_WORD_RE = re.compile(r"[0-9A-Za-zА-Яа-яЁё]")


def check_transcript(text: str, no_speech_prob: Optional[float] = None,
                     avg_logprob: Optional[float] = None, language: str = "ru") -> Tuple[bool, str]:
    """Returns (accept, reason)."""
    clean = (text or "").strip()
    if not clean or not _HAS_WORD_RE.search(clean):
        return False, "empty_transcript"
    pattern = _HALLUCINATION_RE.get(language)
    if pattern is not None and pattern.search(clean):
        return False, "known_hallucination"
    if no_speech_prob is not None and avg_logprob is not None:
        if no_speech_prob > 0.6 and avg_logprob < -1.0:
            return False, "low_confidence_no_speech"
    return True, "ok"
