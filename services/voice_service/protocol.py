"""JSON-lines protocol plumbing (stdin: commands, stdout: events)."""
import json
import threading
from typing import Any, BinaryIO, Dict, Iterator


class Emitter:
    """Thread-safe event writer. One JSON object per line, UTF-8."""

    def __init__(self, stream: BinaryIO):
        self._stream = stream
        self._lock = threading.Lock()
        self.closed = False

    def emit(self, event: str, **fields: Any) -> None:
        payload: Dict[str, Any] = {"event": event}
        payload.update(fields)
        data = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        with self._lock:
            if self.closed:
                return
            try:
                self._stream.write(data)
                self._stream.flush()
            except (BrokenPipeError, OSError, ValueError):
                # the parent went away; nothing useful can be done with events
                self.closed = True

    def emit_binary(self, event: str, payload: bytes, **fields: Any) -> None:
        """Event with a binary payload (VC-M3.2): the line "!<N> <json>" followed by N raw bytes.

        Header and payload are written under one lock, so no other event can
        land between them. The reader (core/util/frames.js) tells this frame
        from a JSON line by its first byte.
        """
        if not payload:
            raise ValueError("empty binary payload")
        header: Dict[str, Any] = {"event": event}
        header.update(fields)
        line = ("!%d " % len(payload) + json.dumps(header, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        with self._lock:
            if self.closed:
                return
            try:
                self._stream.write(line)
                self._stream.write(payload)
                self._stream.flush()
            except (BrokenPipeError, OSError, ValueError):
                self.closed = True

    def status(self, component: str, state: str, detail: str = "", **info: Any) -> None:
        self.emit("status", component=component, state=state, detail=detail, info=info)

    def log(self, level: str, message: str) -> None:
        self.emit("log", level=level, message=message)


def read_commands(stream: BinaryIO) -> Iterator[Dict[str, Any]]:
    """Yield parsed command objects until EOF. Malformed lines are skipped."""
    while True:
        line = stream.readline()
        if not line:
            return
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
        else:
            yield {"cmd": "_malformed", "raw": str(obj)[:200]}
