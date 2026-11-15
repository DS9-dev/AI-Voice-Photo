"""Local frame publisher: multipart MJPEG over HTTP on 127.0.0.1.

The window shows the live face with a plain <img src=".../stream.mjpg">: no decoding code
in the renderer, and full-screen / layout changes never restart the stream. Frames are pushed
at the moment they are due (the avatar paces them by the audio clock), so the page just shows
whatever arrives.
"""
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BOUNDARY = b"avpframe"


class FrameHub:
    def __init__(self):
        self.cv = threading.Condition()
        self.jpg = None
        self.seq = 0
        self.clients = 0

    def publish(self, jpg, k):
        with self.cv:
            if jpg is not None:
                self.jpg = jpg
                self.seq += 1
            self.cv.notify_all()

    def wait_next(self, last_seq, timeout=1.0):
        with self.cv:
            if self.seq == last_seq:
                self.cv.wait(timeout)
            return self.seq, self.jpg


def serve(hub: FrameHub, port: int = 0):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *args):  # keep stderr quiet
            pass

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/frame.jpg":
                _, jpg = hub.wait_next(-1, 0)
                if jpg is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(jpg)))
                self.end_headers()
                self.wfile.write(jpg)
                return
            if path != "/stream.mjpg":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=" + BOUNDARY.decode())
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            hub.clients += 1
            seq = -1
            try:
                while True:
                    new_seq, jpg = hub.wait_next(seq)
                    if jpg is None or new_seq == seq:
                        continue
                    seq = new_seq
                    self.wfile.write(b"--" + BOUNDARY + b"\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                     + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                hub.clients -= 1

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    th = threading.Thread(target=srv.serve_forever, name="mjpeg", daemon=True)
    th.start()
    return srv, srv.server_address[1]
