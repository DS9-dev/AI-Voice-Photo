"""Direct TTS smoke test: real model, real synthesis, real audio.

    python -m services.voice_service.tts_smoke --model-id v5_5_ru --voice xenia ...

(normally started through tts_smoke.bat / scripts/tts_smoke.js, which pass the
values of the application configuration).

Steps: certificate diagnosis for the model host, model installation if it is
missing, model load, one short synthesis, WAV file, playback through the
application's own audio output path. Everything measured is written to a JSON
report. Exit code 0 only if the model loaded, produced non-silent audio in the
configured voice, and (unless --no-play) the audio was played to the end.
"""
import argparse
import json
import os
import sys
import threading
import time
import wave
from typing import Any, Callable, Dict, Optional

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import numpy as np

DEFAULT_TEXT = "Привет! Это проверка синтеза речи. Меня хорошо слышно?"


def _write_wav(path: str, audio: np.ndarray, sample_rate: int) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())


def _play(audio: np.ndarray, sample_rate: int, device: str, host_api: str,
          make_output: Optional[Callable[..., Any]] = None) -> Dict[str, Any]:
    """Play through the application's AudioOutput and wait for the end event."""
    from .clock import now_ms
    if make_output is None:
        from .audio.playback import AudioOutput
        make_output = AudioOutput
    done = threading.Event()
    marks: Dict[str, float] = {}

    def on_event(kind: str, tag: Any, t_ms: float) -> None:
        marks[kind] = t_ms
        if kind == "end":
            done.set()

    out = make_output(sample_rate, on_event)
    info: Dict[str, Any] = {"requested_device": device or "(system default)"}
    t_open = now_ms()
    notes = out.open(device, host_api)
    info.update(device=out.device_name, host_api=out.host_api, output_latency_ms=round(out.latency_ms, 1), notes=notes)
    t_queued = now_ms()
    out.play(audio, "smoke")
    finished = done.wait(timeout=len(audio) / sample_rate + 10.0)
    time.sleep(0.25)  # let the device drain its last buffer before closing
    out.close()
    info.update(
        completed=bool(finished),
        open_ms=round(t_queued - t_open, 1),
        queue_to_start_ms=round(marks["start"] - t_queued, 1) if "start" in marks else None,
        played_ms=round(marks["end"] - marks["start"], 1) if "start" in marks and "end" in marks else None,
    )
    return info


def run_smoke(args: argparse.Namespace, make_tts: Optional[Callable[..., Any]] = None,
              make_output: Optional[Callable[..., Any]] = None,
              diagnose: Optional[Callable[[], Dict[str, Any]]] = None,
              say: Callable[[str], None] = print) -> Dict[str, Any]:
    report: Dict[str, Any] = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "requested": {"model_id": args.model_id, "voice": args.voice, "language": args.language,
                      "device": args.device, "sample_rate": args.sample_rate, "text": args.text},
        "ok": False, "checks": [], "error": None,
    }

    def check(name: str, ok: bool, detail: str = "") -> bool:
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        say(f"  [{'ok' if ok else 'FAIL'}] {name}{' — ' + detail if detail else ''}")
        return bool(ok)

    # 1. certificate diagnosis (facts only; nothing depends on its outcome)
    if not args.no_tls_check:
        say("Certificate check for the model host…")
        try:
            if diagnose is None:
                from .tts.model_store import tls_diagnostics
                diagnose = tls_diagnostics
            report["tls"] = diagnose()
            for v in report["tls"].get("verification", []):
                say(f"  {v['trust_store']}: {'verified' if v.get('ok') else 'FAILED — ' + str(v.get('verify_message') or v.get('error'))}")
            for c in report["tls"].get("presented_chain", []):
                say(f"    chain: {c['subject']}  (until {c['not_after']}{', EXPIRED' if c.get('expired') else ''})")
            for c in report["tls"].get("system_store_matches", []):
                if c.get("expired"):
                    say(f"    Windows store, EXPIRED: {c['subject']}  (until {c['not_after']})")
            say(f"  conclusion: {report['tls'].get('conclusion')}")
        except Exception as exc:  # the diagnosis must never block the smoke test
            report["tls"] = {"error": f"{type(exc).__name__}: {exc}"}

    try:
        # 2. model installation + load
        say("Loading the TTS model…")
        t0 = time.perf_counter()
        injected = make_tts is not None  # unit tests inject a fake engine
        if make_tts is None:
            import torch  # noqa: F401  (import time is part of initialization)
            from .tts.silero_tts import SileroTts
            make_tts = SileroTts
        t_import = time.perf_counter()
        tts = make_tts(args.model_id, args.voice, args.device, args.threads, args.sample_rate, args.models_dir,
                       args.language)
        tts.load()
        t_loaded = time.perf_counter()
        info = tts.describe()
        report["model"] = info
        report["install"] = getattr(tts, "install", {})
        report["initialization"] = {
            "import_ms": round((t_import - t0) * 1000.0, 1),
            "install_and_load_ms": round((t_loaded - t_import) * 1000.0, 1),
            "of_which_model_load_ms": info.get("load_ms"),
            "of_which_warmup_synthesis_ms": info.get("warmup_ms"),
            "total_ms": round((t_loaded - t0) * 1000.0, 1),
            "model_downloaded_in_this_run": bool(report["install"].get("downloaded")),
        }
        check("Model file installed locally", bool(report["install"].get("path")) or injected,
              f"{report['install'].get('path', '')} ({report['install'].get('bytes', '?')} bytes, sha256 {report['install'].get('sha256', '?')})")
        check("Model loaded", True, f"{info.get('model')} on {info.get('device')}, initialization {report['initialization']['total_ms']:.0f} ms")
        check("Configured model is the one loaded", info.get("model") == args.model_id, f"{info.get('model')}")
        check("Configured voice is the one selected", info.get("voice") == args.voice, f"{info.get('voice')} (available: {', '.join(info.get('voices', []))})")
        check("Voice is one of the model's speakers", info.get("voice") in info.get("voices", []), f"speakers: {', '.join(info.get('voices', []))}")
        check("Language", info.get("language") == args.language, str(info.get("language")))

        # 3. synthesis
        say("Synthesizing…")
        t1 = time.perf_counter()
        audio = tts.synthesize(args.text)
        synth_ms = (time.perf_counter() - t1) * 1000.0
        audio_ms = len(audio) * 1000.0 / tts.sample_rate
        rms = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0.0
        peak = float(np.max(np.abs(audio))) if len(audio) else 0.0
        report["synthesis"] = {
            "text": args.text, "synthesis_ms": round(synth_ms, 1), "audio_ms": round(audio_ms, 1),
            "real_time_factor": round(synth_ms / audio_ms, 4) if audio_ms else None,
            "sample_rate": tts.sample_rate, "samples": int(len(audio)), "rms": round(rms, 5), "peak": round(peak, 5),
            "streaming": False,
        }
        check("Audio was produced", audio_ms > 500.0, f"{audio_ms:.0f} ms of audio in {synth_ms:.0f} ms")
        check("Audio is not silent", rms > 0.005, f"rms {rms:.4f}, peak {peak:.3f}")

        # 4. real audio out
        if args.wav and len(audio):
            _write_wav(args.wav, audio, tts.sample_rate)
            report["wav"] = os.path.abspath(args.wav)
            say(f"  wrote {report['wav']}")
        if args.no_play:
            report["playback"] = {"skipped": True}
        elif len(audio):
            say("Playing…")
            report["playback"] = _play(audio, tts.sample_rate, args.output_device, args.host_api, make_output)
            check("Audio was played to the end", report["playback"].get("completed") is True,
                  f"device '{report['playback'].get('device')}' via {report['playback'].get('host_api')}")
    except Exception as exc:
        import traceback
        report["error"] = f"{type(exc).__name__}: {exc}"
        report["traceback"] = traceback.format_exc()
        check("Smoke test ran without an exception", False, report["error"])

    report["ok"] = report["error"] is None and bool(report["checks"]) and all(c["ok"] for c in report["checks"])
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-id", default="v5_5_ru")
    parser.add_argument("--voice", default="xenia")
    parser.add_argument("--language", default="ru")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--sample-rate", type=int, default=48000)
    parser.add_argument("--models-dir", default="models")
    parser.add_argument("--output-device", default="")
    parser.add_argument("--host-api", default="auto")
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--wav", default=os.path.join("artifacts", "tmp", "tts_smoke.wav"))
    parser.add_argument("--report", default=os.path.join("artifacts", "reports", "tts_smoke.json"))
    parser.add_argument("--no-play", action="store_true")
    parser.add_argument("--no-tls-check", action="store_true")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    report = run_smoke(args)
    os.makedirs(os.path.dirname(args.report) or ".", exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    print("")
    if report.get("model"):
        m, i, s = report["model"], report.get("initialization", {}), report.get("synthesis", {})
        print(f"Model / voice:        {m.get('model')} / {m.get('voice')}  (language {m.get('language')}, device {m.get('device')})")
        print(f"Initialization time:  {i.get('total_ms')} ms  (import {i.get('import_ms')}, load {i.get('of_which_model_load_ms')}, warm-up {i.get('of_which_warmup_synthesis_ms')}"
              f"{', model was downloaded in this run' if i.get('model_downloaded_in_this_run') else ''})")
        if s:
            print(f"Synthesis time:       {s.get('synthesis_ms')} ms for {s.get('audio_ms')} ms of audio  (real-time factor {s.get('real_time_factor')})")
    print(f"RESULT: {'PASS' if report['ok'] else 'FAIL'}")
    print(f"Report: {os.path.abspath(args.report)}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
