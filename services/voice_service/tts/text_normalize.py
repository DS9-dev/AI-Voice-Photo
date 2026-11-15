"""Text clean-up for Silero TTS, per conversation language.

Only Russian is implemented (the VC-M0 language). `normalizer_for(language)`
is the lookup the TTS provider uses; adding a language means adding a
normalizer here.


Silero's Russian models read Cyrillic text and punctuation. Digits, Latin
letters, emoji and markup are not handled by the model, so they are
converted or removed here. This is deliberately small: the LLM is also
instructed to answer in plain spoken Russian.
"""
import re
from typing import List

_ONES_M = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"]
_ONES_F = ["ноль", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"]
_TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать",
          "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"]
_TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят",
         "восемьдесят", "девяносто"]
_HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот",
             "восемьсот", "девятьсот"]
_SCALES = [
    None,
    ("тысяча", "тысячи", "тысяч", True),
    ("миллион", "миллиона", "миллионов", False),
    ("миллиард", "миллиарда", "миллиардов", False),
]


def _plural(n: int, forms) -> str:
    n = abs(n) % 100
    if 11 <= n <= 14:
        return forms[2]
    d = n % 10
    if d == 1:
        return forms[0]
    if 2 <= d <= 4:
        return forms[1]
    return forms[2]


def _triplet(n: int, feminine: bool) -> List[str]:
    words: List[str] = []
    h, rest = divmod(n, 100)
    if h:
        words.append(_HUNDREDS[h])
    if 10 <= rest <= 19:
        words.append(_TEENS[rest - 10])
    else:
        t, o = divmod(rest, 10)
        if t:
            words.append(_TENS[t])
        if o:
            words.append((_ONES_F if feminine else _ONES_M)[o])
    return words


def number_to_words(n: int) -> str:
    """Cardinal number in Russian (nominative, masculine). |n| < 10^12."""
    if n == 0:
        return "ноль"
    if n < 0:
        return "минус " + number_to_words(-n)
    if n >= 10 ** 12:
        return " ".join(_ONES_M[int(d)] for d in str(n))
    parts: List[str] = []
    scale = 0
    while n > 0:
        n, chunk = divmod(n, 1000)
        if chunk:
            if scale == 0:
                words = _triplet(chunk, False)
            else:
                one, few, many, feminine = _SCALES[scale]
                words = _triplet(chunk, feminine) + [_plural(chunk, (one, few, many))]
            parts.insert(0, " ".join(words))
        scale += 1
    return " ".join(parts)


_LATIN = {
    "a": "а", "b": "б", "c": "к", "d": "д", "e": "е", "f": "ф", "g": "г", "h": "х", "i": "и",
    "j": "дж", "k": "к", "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "q": "к", "r": "р",
    "s": "с", "t": "т", "u": "у", "v": "в", "w": "в", "x": "кс", "y": "й", "z": "з",
}

_SYMBOL_WORDS = {
    "%": " процентов ", "№": " номер ", "&": " и ", "+": " плюс ", "=": " равно ",
    "€": " евро ", "$": " долларов ", "₽": " рублей ", "°": " градусов ",
}

_NUMBER_RE = re.compile(r"\d+(?:[.,]\d+)?")
_ALLOWED_RE = re.compile(r"[^а-яёА-ЯЁ0-9 .,!?…:;\-—–]")
_SPACE_RE = re.compile(r"\s+")


def _number_repl(match: "re.Match[str]") -> str:
    token = match.group(0)
    if "." in token or "," in token:
        whole, frac = re.split(r"[.,]", token, maxsplit=1)
        frac_words = " ".join(_ONES_M[int(d)] for d in frac) if len(frac) > 3 else number_to_words(int(frac))
        if frac.startswith("0") and len(frac) <= 3:
            frac_words = " ".join(_ONES_M[int(d)] for d in frac)
        return f" {number_to_words(int(whole))} и {frac_words} "
    return f" {number_to_words(int(token))} "


def normalize_for_tts(text: str) -> str:
    """Return text containing only what the Russian Silero model can read."""
    t = text.replace(" ", " ")
    t = re.sub(r"[*_`#~>|\[\](){}<>\\/\"«»“”„]", " ", t)       # markup, quotes, brackets
    for sym, word in _SYMBOL_WORDS.items():
        t = t.replace(sym, word)
    t = _NUMBER_RE.sub(_number_repl, t)
    t = "".join(_LATIN.get(ch, _LATIN.get(ch.lower(), ch)) if ch.isascii() and ch.isalpha() else ch for ch in t)
    t = _ALLOWED_RE.sub(" ", t)
    t = _SPACE_RE.sub(" ", t).strip()
    t = re.sub(r"\s+([.,!?…:;])", r"\1", t)
    t = re.sub(r"^[.,!?…:;\-—– ]+", "", t)
    return t


def has_speakable(text: str) -> bool:
    return re.search(r"[а-яёА-ЯЁ]", text) is not None


def split_long(text: str, max_chars: int = 600) -> List[str]:
    """Silero has a per-call length limit; split overly long chunks at commas/spaces."""
    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []
    parts: List[str] = []
    rest = text
    while len(rest) > max_chars:
        window = rest[:max_chars]
        cut = max(window.rfind(", "), window.rfind("; "), window.rfind(": "))
        if cut < max_chars // 3:
            cut = window.rfind(" ")
        if cut <= 0:
            cut = max_chars - 1
        parts.append(rest[:cut + 1].strip())
        rest = rest[cut + 1:].strip()
    if rest:
        parts.append(rest)
    return parts


def has_speakable_ru(text: str) -> bool:
    return has_speakable(text)


# language code -> (normalize, has_speakable)
NORMALIZERS = {
    "ru": (normalize_for_tts, has_speakable_ru),
}


def normalizer_for(language: str):
    """Returns (normalize, has_speakable) for a language, or raises ValueError."""
    try:
        return NORMALIZERS[language]
    except KeyError:
        raise ValueError(f"No TTS text normalizer for language '{language}'") from None
