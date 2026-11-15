"""Best-effort process RAM and GPU memory readings (never raises)."""
import os
import subprocess
import sys
from typing import Any, Dict, List, Optional


def process_rss_mb() -> Optional[float]:
    try:
        import psutil
        return round(psutil.Process(os.getpid()).memory_info().rss / 1048576.0, 1)
    except Exception:
        return None


def gpu_info() -> Optional[List[Dict[str, Any]]]:
    """Per-GPU memory via nvidia-smi (whole GPU, includes LM Studio's usage)."""
    try:
        flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=4, creationflags=flags,
        )
        if out.returncode != 0:
            return None
        gpus = []
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 4:
                gpus.append({
                    "name": parts[0],
                    "memory_used_mb": float(parts[1]),
                    "memory_total_mb": float(parts[2]),
                    "utilization_pct": float(parts[3]),
                })
        return gpus or None
    except Exception:
        return None


def snapshot() -> Dict[str, Any]:
    return {"rss_mb": process_rss_mb(), "gpu": gpu_info()}
