"""Voice selection smoke test (VC-M1.2): every speaker of the real TTS model.

    python -m services.voice_service.voice_smoke --model-id v5_5_ru --default-voice xenia ...

(normally started through voice_smoke.bat / scripts/voice_smoke.js, which pass
the values of the application configuration and the voice list the
application offers).

What it establishes, with the real model and the application's own provider
(services/voice_service/tts/silero_tts.py):

  - which speakers the installed model itself reports, and whether that is
    the list the application offers;
  - that every speaker synthesizes the preview sentence into real audio;
  - that the speaker is chosen per synthesis with ONE loaded model (no reload);
  - that the selections really are different voices and not one voice under
    five names: fingerprints differ, and the spectra of different speakers are
    further apart than two syntheses of the same speaker;
  - that a voice the model does not have is refused, not replaced;
  - that switching the configured voice (what the application does when the
    active character changes) takes effect on the next synthesis.

With --play every sample is also played through the application's audio
output, one after another, so the voices can be compared by ear. Everything
measured goes into a JSON report. Exit code 0 only if every check passed.
"""
import argparse
import hashlib
import json
import os
import sys
import time
from typing import Any, Callable, Dict, List, Optional

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import numpy as np

from .tts_smoke import _play, _write_wav

DEFAULT_TEXT = "Привет. Это пример моего голоса. Так я буду звучать в разговоре."
NO_SUCH_VOICE = "no_such_voice"
SPECTRUM_BANDS = 48


def fingerprint(audio: np.ndarray) -> str:
    """SHA-256 of the waveform as 16-bit PCM (what is written to a WAV file)."""
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    return hashlib.sha256(pcm.tobytes()).hexdigest()


def average_spectrum(audio: np.ndarray, sample_rate: int, bands: int = SPECTRUM_BANDS) -> np.ndarray:
    """Long-term average spectrum in dB over log-spaced bands, level-normalized.

    A coarse description of a voice's timbre and pitch range that does not
    depend on timing: two syntheses of one speaker are close, two speakers
    are further apart."""
    if len(audio) < 2048:
        return np.zeros(bands, dtype=np.float64)
    frame, hop = 2048, 512
    window = np.hanning(frame)
    count = 1 + (len(audio) - frame) // hop
    power = np.zeros(frame // 2 + 1, dtype=np.float64)
    for i in range(count):
        chunk = audio[i * hop:i * hop + frame].astype(np.float64) * window
        power += np.abs(np.fft.rfft(chunk)) ** 2
    power /= max(1, count)
    freqs = np.fft.rfftfreq(frame, 1.0 / sample_rate)
    edges = np.geomspace(60.0, min(8000.0, sample_rate / 2.0 - 1.0), bands + 1)
    out = np.empty(bands, dtype=np.float64)
    for b in range(bands):
        mask = (freqs >= edges[b]) & (freqs < edges[b + 1])
        out[b] = power[mask].mean() if mask.any() else 0.0
    db = 10.0 * np.log10(out + 1e-12)
    return db - db.mean()


def spectrum_distance(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a - b)))


def run_voice_smoke(args: argparse.Namespace, make_tts: Optional[Callable[..., Any]] = None,
                    make_output: Optional[Callable[..., Any]] = None,
                    say: Callable[[str], None] = print) -> Dict[str, Any]:
    expected: List[str] = [v for v in (args.expected or "").split(",") if v]
    report: Dict[str, Any] = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "requested": {"model_id": args.model_id, "language": args.language, "device": args.device,
                      "sample_rate": args.sample_rate, "default_voice": args.default_voice,
                      "voices_offered_by_application": expected, "text": args.text, "play": bool(args.play)},
        "ok": False, "checks": [], "error": None, "speakers": [], "voices": {},
    }

    def check(name: str, ok: bool, detail: str = "") -> bool:
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        say(f"  [{'ok' if ok else 'FAIL'}] {name}{' — ' + detail if detail else ''}")
        return bool(ok)

    try:
        say("Loading the TTS model (once)…")
        t0 = time.perf_counter()
        if make_tts is None:
            import torch  # noqa: F401
            from .tts.silero_tts import SileroTts
            make_tts = SileroTts
        tts = make_tts(args.model_id, args.default_voice, args.device, args.threads, args.sample_rate,
                       args.models_dir, args.language)
        tts.load()
        info = tts.describe()
        model_object = getattr(tts, "model", None)
        report["model"] = {k: info.get(k) for k in ("provider", "model", "language", "device", "sample_rate",
                                                     "model_sha256", "model_bytes", "load_ms", "warmup_ms", "voice")}
        report["model"]["load_total_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        speakers = list(info.get("voices") or [])
        report["speakers"] = speakers
        say(f"  model {info.get('model')} on {info.get('device')}; speakers reported by the model: {', '.join(speakers) or '(none)'}")

        check("The model reports its speakers", len(speakers) > 0, ", ".join(speakers))
        if expected:
            check("The application offers exactly the model's speakers", sorted(expected) == sorted(speakers),
                  f"application: {', '.join(sorted(expected))}; model: {', '.join(sorted(speakers))}")
        check("The default voice is one of them", args.default_voice in speakers, args.default_voice)
        check("The default voice is the one selected after loading", info.get("voice") == args.default_voice, str(info.get("voice")))

        # every speaker, chosen per synthesis, same loaded model
        spectra: Dict[str, np.ndarray] = {}
        for speaker in speakers:
            t1 = time.perf_counter()
            audio = tts.synthesize(args.text, voice=speaker)
            synth_ms = (time.perf_counter() - t1) * 1000.0
            audio_ms = len(audio) * 1000.0 / tts.sample_rate
            rms = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0.0
            entry: Dict[str, Any] = {
                "samples": int(len(audio)), "audio_ms": round(audio_ms, 1), "synthesis_ms": round(synth_ms, 1),
                "rms": round(rms, 5), "peak": round(float(np.max(np.abs(audio))) if len(audio) else 0.0, 5),
                "sha256_pcm16": fingerprint(audio) if len(audio) else None,
            }
            spectra[speaker] = average_spectrum(audio, tts.sample_rate)
            if args.wav_dir and len(audio):
                entry["wav"] = os.path.abspath(os.path.join(args.wav_dir, f"voice_{speaker}.wav"))
                _write_wav(entry["wav"], audio, tts.sample_rate)
            report["voices"][speaker] = entry
            check(f"{speaker}: audio produced and not silent", audio_ms > 500.0 and rms > 0.005,
                  f"{audio_ms:.0f} ms of audio in {synth_ms:.0f} ms, rms {rms:.4f}")
            if args.play and len(audio):
                say(f"  playing {speaker}…")
                entry["playback"] = _play(audio, tts.sample_rate, args.output_device, args.host_api, make_output)
                check(f"{speaker}: played to the end", entry["playback"].get("completed") is True,
                      f"device '{entry['playback'].get('device')}'")

        check("One loaded model served every speaker (no reload)",
              getattr(tts, "model", None) is model_object, "the model object did not change")

        # are these different voices, or one voice under several names?
        prints = [report["voices"][s]["sha256_pcm16"] for s in speakers]
        check("Every speaker gives different audio", len(set(prints)) == len(prints) and None not in prints,
              f"{len(set(prints))} distinct waveforms for {len(speakers)} speakers")
        repeat = tts.synthesize(args.text, voice=args.default_voice) if args.default_voice in speakers else np.zeros(0, dtype=np.float32)
        within = spectrum_distance(spectra.get(args.default_voice, np.zeros(SPECTRUM_BANDS)), average_spectrum(repeat, tts.sample_rate))
        between = {f"{a}/{b}": round(spectrum_distance(spectra[a], spectra[b]), 3)
                   for i, a in enumerate(speakers) for b in speakers[i + 1:]}
        report["distinctness"] = {
            "method": "mean absolute difference of level-normalized long-term average spectra, dB",
            "same_speaker_repeat": round(within, 3),
            "same_speaker_repeat_identical_waveform": bool(len(repeat)) and fingerprint(repeat) == report["voices"].get(args.default_voice, {}).get("sha256_pcm16"),
            "between_speakers": between,
            "smallest_between_speakers": min(between.values()) if between else None,
        }
        if between:
            closest = min(between, key=between.get)
            check("Different speakers differ more than two syntheses of the same speaker",
                  between[closest] > within,
                  f"closest pair {closest}: {between[closest]:.2f} dB; {args.default_voice} twice: {within:.2f} dB")

        # a voice the model does not have must be refused, never replaced
        try:
            tts.synthesize(args.text, voice=NO_SUCH_VOICE)
            refused, detail = False, "it was synthesized (hidden fallback)"
        except Exception as exc:
            refused, detail = True, f"{type(exc).__name__}: {exc}"
        report["unknown_voice"] = {"refused": refused, "detail": detail}
        check("An unknown voice is refused, not replaced", refused, detail[:160])

        # the configured voice (the active character's) changes without a reload
        other = next((s for s in speakers if s != args.default_voice), None)
        if other:
            switched = tts.set_voice(other)
            audio = tts.synthesize(args.text) if switched else np.zeros(0, dtype=np.float32)
            spec = average_spectrum(audio, tts.sample_rate)
            to_other = spectrum_distance(spec, spectra[other])
            to_default = spectrum_distance(spec, spectra[args.default_voice]) if args.default_voice in spectra else None
            back = tts.set_voice(args.default_voice) if args.default_voice in speakers else False
            report["live_switch"] = {
                "from": args.default_voice, "to": other, "accepted": bool(switched),
                "distance_to_new_voice": round(to_other, 3),
                "distance_to_previous_voice": round(to_default, 3) if to_default is not None else None,
                "identical_to_explicit_selection": bool(len(audio)) and fingerprint(audio) == report["voices"][other]["sha256_pcm16"],
                "switched_back": bool(back), "model_reloaded": getattr(tts, "model", None) is not model_object,
            }
            check(f"Switching the configured voice to {other} applies to the next synthesis",
                  bool(switched) and len(audio) > 0 and (to_default is None or to_other < to_default)
                  and getattr(tts, "model", None) is model_object,
                  f"next synthesis: {to_other:.2f} dB from {other}, {to_default if to_default is None else format(to_default, '.2f')} dB from {args.default_voice}; no reload")
    except Exception as exc:
        import traceback
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
        check("Voice smoke test ran without an exception", False, report["error"])

    report["ok"] = report["error"] is None and bool(report["checks"]) and all(c["ok"] for c in report["checks"])
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-id", default="v5_5_ru")
    parser.add_argument("--default-voice", default="xenia")
    parser.add_argument("--expected", default="", help="comma-separated voices the application offers")
    parser.add_argument("--language", default="ru")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--sample-rate", type=int, default=48000)
    parser.add_argument("--models-dir", default="models")
    parser.add_argument("--output-device", default="")
    parser.add_argument("--host-api", default="auto")
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--wav-dir", default=os.path.join("artifacts", "tmp"))
    parser.add_argument("--report", default=os.path.join("artifacts", "reports", "voice_smoke.json"))
    parser.add_argument("--play", action="store_true", help="also play every sample through the audio output")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    report = run_voice_smoke(args)
    os.makedirs(os.path.dirname(args.report) or ".", exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"\nReport: {os.path.abspath(args.report)}")
    print(f"RESULT: {'PASS' if report['ok'] else 'FAIL'}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
