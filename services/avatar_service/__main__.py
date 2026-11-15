"""Entry point: python -u -m services.avatar_service [--app=<name>]  (from the project root,
with the avatar environment .venv_avatar). --app only marks the process for stop_helpers."""
import logging
import os
import sys

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")


def read_commands_nonblocking(stream):
    """Windows: never keep a synchronous read pending on the stdin pipe.

    While one thread blocks in ReadFile on an anonymous pipe, any other thread that queries
    that handle (GetFileType - done by DLL/extension loading, e.g. numpy) blocks too: the
    model-loading thread hung forever on `import numpy` (AVP-04). So stdin is polled with
    PeekNamedPipe and only bytes that are already there are read.
    """
    import json
    import time
    if os.name != "nt":
        from services.voice_service.protocol import read_commands
        yield from read_commands(stream)
        return
    import msvcrt
    import _winapi
    fd = stream.fileno()
    handle = msvcrt.get_osfhandle(fd)
    buf = b""
    while True:
        try:
            avail = _winapi.PeekNamedPipe(handle, 0)[0]
        except (BrokenPipeError, OSError):
            return  # parent gone: EOF
        if not avail:
            time.sleep(0.005)
            continue
        chunk = os.read(fd, avail)
        if not chunk:
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                yield {"cmd": "_malformed", "raw": line[:200].decode("utf-8", "replace")}
                continue
            if isinstance(obj, dict) and isinstance(obj.get("cmd"), str):
                yield obj


def main() -> int:
    # only this module writes to the real stdout (the protocol channel); prints of
    # libraries (Ditto prints its config) go to stderr, which the core keeps as a log
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
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    from services.voice_service.protocol import Emitter
    from .service import AvatarService

    emitter = Emitter(proto_out)
    service = AvatarService(emitter)
    service.hello()
    try:
        for cmd in read_commands_nonblocking(sys.stdin.buffer):
            service.handle(cmd)
            if service.stopped:
                break
    except KeyboardInterrupt:
        pass
    finally:
        service.shutdown()
        try:
            proto_out.flush()
        except Exception:
            pass
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
