"""Read the speaker list of a Silero TTS model file WITHOUT loading the model.

    python -m services.voice_service.model_speakers models/silero/v5_5_ru.pt [--json]

A Silero .pt file is a torch.package archive (a zip). The model object in it
is a pickle whose attributes include `speakers` and `speaker_to_ids`. This
tool reads exactly that pickle with every class replaced by an inert
placeholder, so no code from the archive is imported or executed and neither
PyTorch nor the model weights are needed. It answers one question from the
file itself: which speakers does this model have?

It is static evidence about the file. That every speaker actually
synthesizes is established separately, with the real model, by
voice_smoke.py.
"""
import argparse
import hashlib
import io
import json
import os
import pickle
import sys
import zipfile
from typing import Any, Dict, List, Optional


class _Placeholder:
    """Stands in for every class and function the pickle refers to."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    def __call__(self, *args: Any, **kwargs: Any) -> "_Placeholder":
        return _Placeholder()

    def __setstate__(self, state: Any) -> None:
        if isinstance(state, dict):
            self.__dict__.update(state)
        elif isinstance(state, tuple) and len(state) == 2 and isinstance(state[1], dict):
            self.__dict__.update(state[1])
        else:
            self.__dict__["_state"] = state

    # containers some pickles build through list/dict protocol calls
    def append(self, item: Any) -> None:
        self.__dict__.setdefault("_items", []).append(item)

    def extend(self, items: Any) -> None:
        self.__dict__.setdefault("_items", []).extend(items)

    def __setitem__(self, key: Any, value: Any) -> None:
        self.__dict__.setdefault("_map", {})[key] = value


class _InertUnpickler(pickle.Unpickler):
    """Resolves every global to a placeholder and every stored tensor to None."""

    def find_class(self, module: str, name: str) -> Any:  # noqa: D401 - pickle API
        if module == "collections" and name == "OrderedDict":
            return dict
        return _Placeholder

    def persistent_load(self, pid: Any) -> Any:
        return None


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect_model(path: str) -> Dict[str, Any]:
    """Speakers and related attributes of the model stored in `path`."""
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        # torch.package stores the pickled model object as <package>/tts_models/model
        wanted = [n for n in names if n.endswith("tts_models/model") or n.endswith("tts_models/model.pkl")]
        if not wanted:
            raise ValueError("no tts_models/model entry in the archive: not a Silero TTS package")
        member = wanted[0]
        raw = archive.read(member)
        # the Python source of the model class travels in the same archive; it is read as text only
        sources = [n for n in names if n.endswith(".py") and "/" in n and n.count("/") == 1]
        source = "\n".join(archive.read(n).decode("utf-8", errors="replace") for n in sources)
    model = _InertUnpickler(io.BytesIO(raw)).load()
    attrs = getattr(model, "__dict__", {})

    def plain(value: Any) -> Any:
        if isinstance(value, dict):
            return {str(k): plain(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [plain(v) for v in value]
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        return f"<{type(value).__name__}>"

    speakers: Optional[List[str]] = None
    if isinstance(attrs.get("speakers"), (list, tuple)):
        speakers = [str(s) for s in attrs["speakers"]]
    # v5 models wrap one or more inner packages; each carries its own speaker table
    inner = [getattr(p, "__dict__", {}) for p in attrs.get("packages", []) or [] if hasattr(p, "__dict__")]
    tables = [plain(d.get("speaker_to_ids")) for d in inner if "speaker_to_ids" in d]
    if "speaker_to_ids" in attrs:
        tables.insert(0, plain(attrs["speaker_to_ids"]))
    if speakers is None:
        speakers = [name for group in tables for table in (group or []) if isinstance(table, dict) for name in table] or None
    return {
        "file": {"bytes": os.path.getsize(path), "sha256": _sha256(path)},
        "archive": {"format": "torch.package (zip)", "members": len(names), "model_pickle": member, "model_pickle_bytes": len(raw), "model_source": sources},
        "method": "the model pickle read with every class replaced by an inert placeholder; nothing from the archive is imported or executed, no weights are loaded",
        "speakers": speakers,
        "speaker_to_package": plain(attrs.get("speaker_to_package")) if "speaker_to_package" in attrs else None,
        "packages": [{"speakers": plain(d.get("speakers")), "speaker_to_ids": plain(d.get("speaker_to_ids")), "speaker_to_model": plain(d.get("speaker_to_model"))} for d in inner],
        # what the model's own code says about speaker selection (plain text search of its source)
        "source": {
            "refuses_unknown_speaker": "`speaker` should be in" in source,
            "has_random_voice_code_path": "speaker == 'random'" in source,
            "sample_rates": [rate for rate in (8000, 24000, 48000) if str(rate) in source and "sample_rate in [" in source],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("model", help="path to the Silero .pt file")
    parser.add_argument("--json", action="store_true", help="print the full result as JSON")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    try:
        result = inspect_model(args.model)
    except Exception as exc:  # a missing or foreign file is a result, not a crash
        print(f"Could not read the speaker list: {type(exc).__name__}: {exc}")
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"{args.model}: {result['file']['bytes']} bytes, sha256 {result['file']['sha256']}")
        print(f"speakers: {', '.join(result['speakers'] or []) or '(not found)'}")
    return 0 if result["speakers"] else 1


if __name__ == "__main__":
    sys.exit(main())
