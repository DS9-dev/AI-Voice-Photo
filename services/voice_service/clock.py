"""Wall-clock milliseconds with monotonic, high-resolution progression.

time.time() alone can have ~15 ms granularity on Windows with older Python
versions, so the epoch is sampled once and advanced with perf_counter().
The residual offset to the application core's clock is measured by the core
at startup (clock_sync command) and removed there.
"""
import time

_WALL0_MS = time.time() * 1000.0
_PC0 = time.perf_counter()


def now_ms() -> float:
    return _WALL0_MS + (time.perf_counter() - _PC0) * 1000.0
