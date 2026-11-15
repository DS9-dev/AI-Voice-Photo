"""Entry point: python -u -m services.voice_service [--app=<name>]  (run from the project root).

--app only marks the process for scripts/stop_helpers.js; it is otherwise ignored.
"""
import logging
import os
import sys

# PyTorch and CTranslate2 each ship an Intel OpenMP runtime on Windows; loading
# both in one process aborts with "OMP: Error #15" unless this is set first.
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")


def main() -> int:
    # Keep the protocol channel clean: only this module writes to the real
    # stdout. Anything else that prints (libraries, C extensions) is sent to
    # stderr, which the application core stores as a log.
    proto_out = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    try:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    except OSError:
        pass
    sys.stdout = sys.stderr
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    logging.basicConfig(stream=sys.stderr, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    from .protocol import Emitter, read_commands
    from .service import VoiceService

    emitter = Emitter(proto_out)
    service = VoiceService(emitter)
    service.hello()
    try:
        for cmd in read_commands(sys.stdin.buffer):
            service.handle(cmd)
            if service.stopped:
                break
    except KeyboardInterrupt:
        pass
    finally:
        # stdin EOF means the parent process is gone: never linger as an orphan
        service.shutdown()
        try:
            proto_out.flush()
        except Exception:
            pass
    # Native inference libraries can block interpreter teardown; cleanup is done.
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
