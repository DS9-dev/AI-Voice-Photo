"""Download model files ahead of time so the first app start is not slow.

    python -m services.voice_service.prefetch --models-dir models --whisper small base --tts v5_5_ru

Internet is needed only here (and for pip). Runtime conversation is local.
"""
import argparse
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", default="models")
    parser.add_argument("--whisper", nargs="*", default=["small"])
    parser.add_argument("--tts", default="v5_5_ru")
    parser.add_argument("--language", default="ru")
    parser.add_argument("--tts-file", default="",
                        help="install the TTS model from this local file instead of downloading it")
    args = parser.parse_args()
    failures = 0

    for name in args.whisper:
        try:
            from faster_whisper.utils import download_model
            cache = os.path.join(args.models_dir, "whisper")
            os.makedirs(cache, exist_ok=True)
            path = download_model(name, cache_dir=cache)
            print(f"[prefetch] whisper {name}: {path}", flush=True)
        except Exception as exc:
            failures += 1
            print(f"[prefetch] whisper {name} FAILED: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)

    if args.tts:
        try:
            from .tts import model_store
            if args.tts_file:
                facts = model_store.install_local(args.tts_file, args.tts, args.models_dir)
            else:
                facts = model_store.ensure_model(args.tts, args.language, args.models_dir)
            how = "installed from local file" if args.tts_file else ("downloaded" if facts["downloaded"] else "already installed")
            print(f"[prefetch] silero tts {args.tts}: {facts['path']} ({facts['bytes'] // 1048576} MB, {how}, "
                  f"sha256 {facts['sha256']})", flush=True)
        except Exception as exc:
            failures += 1
            print(f"[prefetch] silero tts {args.tts} FAILED: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
