"""Environment check: python -m services.voice_service.doctor [--models-dir DIR]

Prints one JSON object describing what is installed and usable. Loads no
large model. Used by scripts/setup.js and scripts/doctor.js.
"""
import argparse
import importlib
import json
import os
import platform
import sys
from typing import Any, Dict

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")  # torch + ctranslate2 in one process (Windows)


def _version(module: str) -> Dict[str, Any]:
    try:
        mod = importlib.import_module(module)
        return {"ok": True, "version": getattr(mod, "__version__", "unknown")}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def collect(models_dir: str) -> Dict[str, Any]:
    report: Dict[str, Any] = {
        "python": platform.python_version(),
        "executable": sys.executable,
        "platform": platform.platform(),
        "packages": {},
    }
    for name in ("numpy", "torch", "onnxruntime", "sounddevice", "psutil"):
        report["packages"][name] = _version(name)

    # torch / CUDA
    torch_info: Dict[str, Any] = {"cuda_available": False}
    try:
        import torch
        torch_info["cuda_available"] = bool(torch.cuda.is_available())
        torch_info["cuda_build"] = getattr(torch.version, "cuda", None)
        if torch_info["cuda_available"]:
            torch_info["device_name"] = torch.cuda.get_device_name(0)
            try:
                torch.zeros(8, device="cuda").sum().item()  # proves kernels run on this GPU
                torch_info["cuda_smoke_test"] = "ok"
            except Exception as exc:
                torch_info["cuda_smoke_test"] = f"failed: {exc}"
    except Exception as exc:
        torch_info["error"] = f"{type(exc).__name__}: {exc}"
    report["torch"] = torch_info

    # CTranslate2 / faster-whisper (after the DLL directories are prepared)
    ct2: Dict[str, Any] = {}
    try:
        from .stt.faster_whisper_stt import prepare_cuda_dlls
        ct2["dll_dirs_added"] = prepare_cuda_dlls()
        import ctranslate2
        ct2["version"] = ctranslate2.__version__
        ct2["cuda_device_count"] = ctranslate2.get_cuda_device_count()
        if ct2["cuda_device_count"] > 0:
            ct2["cuda_compute_types"] = sorted(ctranslate2.get_supported_compute_types("cuda"))
        ct2["cpu_compute_types"] = sorted(ctranslate2.get_supported_compute_types("cpu"))
        report["packages"]["faster_whisper"] = _version("faster_whisper")
    except Exception as exc:
        ct2["error"] = f"{type(exc).__name__}: {exc}"
    report["ctranslate2"] = ct2

    # Silero VAD model file
    try:
        from .vad.silero_onnx import find_model_path
        report["silero_vad_onnx"] = {"ok": True, "path": find_model_path()}
    except Exception as exc:
        report["silero_vad_onnx"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    # audio devices
    audio: Dict[str, Any] = {}
    try:
        from .audio import devices
        listing = devices.list_devices("auto")
        audio["host_api"] = listing["host_api"]
        audio["inputs"] = [d["name"] + (" (default)" if d["is_default"] else "") for d in listing["inputs"]]
        audio["outputs"] = [d["name"] + (" (default)" if d["is_default"] else "") for d in listing["outputs"]]
    except Exception as exc:
        audio["error"] = f"{type(exc).__name__}: {exc}"
    report["audio"] = audio

    # downloaded models
    whisper_dir = os.path.join(models_dir, "whisper")
    silero_dir = os.path.join(models_dir, "silero")
    report["models"] = {
        "models_dir": os.path.abspath(models_dir),
        "whisper_cache_entries": sorted(os.listdir(whisper_dir)) if os.path.isdir(whisper_dir) else [],
        "silero_tts_files": sorted(os.listdir(silero_dir)) if os.path.isdir(silero_dir) else [],
    }

    try:
        from . import resources
        report["gpu"] = resources.gpu_info()
    except Exception:
        report["gpu"] = None
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", default="models")
    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(json.dumps(collect(args.models_dir), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
