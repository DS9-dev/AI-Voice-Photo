"""Avatar service: Ditto photo animation as a separate process (AVP-04).

Same JSON-lines protocol and process contract as the voice service (hello, clock_sync,
shutdown); one status component: 'avatar'.

Commands
  init        {config: {models_dir, photo, max_size, output_device, host_api, out_rate}}
  set_photo   {path}
  play        {turn_id, seq, wav_b64}        one synthesized speech chunk (16-bit PCM WAV)
  stop        {turn_id, reason}
  configure   {config: {output_device, host_api}}
  get_stats   -> stats
  record      {action: start|stop, path}     debug: what was shown + played, for sync checks
Events
  status {component:'avatar', state, detail, info:{stream_url, ...}}
  speech_started {turn_id, seq, tail_ms, delay_ms}
  speech_ended   {turn_id, seq, reason, played_ms, tail_ms}
  level {level}                             loudness of the audio being heard (0..1)
"""
import base64
import os
import pickle
import sys
import threading
import time
import traceback
from typing import Any, Callable, Dict, Optional

from services.voice_service.clock import now_ms

PROTOCOL_VERSION = 1
FEATURES = ("ditto", "mjpeg", "lip_gate")
HERE = os.path.dirname(os.path.abspath(__file__))
DITTO_DIR = os.path.join(HERE, "ditto")


class AvatarService:
    def __init__(self, out):
        self.out = out
        self.stopped = False
        self.cfg: Dict[str, Any] = {}
        self.live = None
        self.hub = None
        self.port = None
        self.state = "stopped"
        self._busy = threading.Lock()

    # -------------------------------------------------------------- basics --

    def hello(self) -> None:
        import platform
        ancestors = [os.getppid()]
        executable = sys.executable
        try:
            import psutil
            me = psutil.Process(os.getpid())
            executable = me.exe() or sys.executable
            ancestors = [p.pid for p in me.parents()[:6]]
        except Exception:
            pass
        self.out.emit("hello", protocol=PROTOCOL_VERSION, pid=os.getpid(), parent_pid=os.getppid(),
                      ancestors=ancestors, executable=executable, launched_as=sys.executable,
                      python=platform.python_version(), platform=sys.platform, features=list(FEATURES))

    def _status(self, state, detail="", **info):
        self.state = state
        if self.port:
            info.setdefault("stream_url", f"http://127.0.0.1:{self.port}/stream.mjpg")
        info.setdefault("photo", (self.live.photo if self.live else "") or "")
        self.out.status("avatar", state, detail, **info)

    def log(self, level, message):
        self.out.log(level, message)

    def handle(self, msg: Dict[str, Any]) -> None:
        cmd = msg.get("cmd")
        fn: Optional[Callable] = getattr(self, f"_cmd_{cmd}", None)
        if fn is None:
            self.out.emit("error", reply_to=msg.get("id"), message=f"unknown command: {cmd}")
            return
        try:
            fn(msg)
        except Exception as exc:
            traceback.print_exc()
            self.out.emit("error", reply_to=msg.get("id"), message=f"{cmd} failed: {exc}")

    def _cmd_clock_sync(self, msg):
        self.out.emit("clock_sync", reply_to=msg.get("id"), service_now_ms=now_ms())

    def _cmd_shutdown(self, msg):
        self.shutdown()
        self.stopped = True

    def shutdown(self):
        try:
            if self.live:
                self.live.stop()
                self.live.close_output()
        except Exception:
            pass

    # ---------------------------------------------------------------- init --

    def _cmd_init(self, msg):
        self.cfg = dict(msg.get("config") or {})
        self._status("loading", "Loading Ditto models")
        threading.Thread(target=self._init_worker, name="avatar-init", daemon=True).start()

    def _init_worker(self):
        with self._busy:
            try:
                t0 = time.perf_counter()
                sys.path.insert(0, DITTO_DIR)
                from services.avatar_service import accel
                from services.avatar_service.live import LiveAvatar
                from services.avatar_service.mjpeg import FrameHub, serve
                import scipy.signal  # noqa: F401  (resampling of speech; importing it on the first answer cost ~3 s)
                models = os.path.join(self.cfg.get("models_dir", "models"), "ditto")
                if not os.path.isdir(os.path.join(models, "ditto_pytorch")):
                    raise RuntimeError(f"Ditto models not found in {models}: run setup_avatar.bat")
                eff = accel.apply(models, use_trt=self.cfg.get("tensorrt", True), log=lambda m: self.log("info", m))
                accel.PUTBACK["sharpen"] = float(self.cfg.get("sharpen", 0.6))
                self.accel = accel
                self.cfg_path = self._online_cfg(models)
                self.data_root = os.path.join(models, "ditto_pytorch")
                self.hub = FrameHub()
                _, self.port = serve(self.hub)
                self.live = LiveAvatar(emit=self.out.emit, log=self.log, out_rate=int(self.cfg.get("out_rate", 48000)))
                self.live.publish = self.hub.publish
                notes = self.live.open_output(self.cfg.get("output_device", ""), self.cfg.get("host_api", "auto"))
                for n in notes:
                    self.log("warning", n)
                load_s = round(time.perf_counter() - t0, 1)
                self.log("info", f"Avatar service ready in {load_s} s (TensorRT: {eff['tensorrt']}, output: {self.live.output_name})")
                photo = self.cfg.get("photo") or ""
                if photo and os.path.exists(photo):
                    self._start_photo(photo)
                else:
                    self._status("ready", "No photo selected", animating=False)
            except Exception as exc:
                traceback.print_exc()
                self._status("error", str(exc))

    def _online_cfg(self, models):
        cfg_dir = os.path.join(models, "ditto_cfg")
        base = pickle.load(open(os.path.join(cfg_dir, "v0.4_hubert_cfg_pytorch.pkl"), "rb"))
        online = pickle.load(open(os.path.join(cfg_dir, "v0.4_hubert_cfg_trt_online.pkl"), "rb"))
        for k in ("online_mode", "sampling_timesteps", "overlap_v2"):
            base["default_kwargs"][k] = online["default_kwargs"][k]
        path = os.path.join(cfg_dir, "avp_pytorch_online.pkl")
        with open(path, "wb") as f:
            pickle.dump(base, f)
        return path

    def _start_photo(self, path):
        self._status("loading", "Preparing the photo")
        t = self.live.start(path, int(self.cfg.get("max_size", 1280)), self.cfg_path, self.data_root)
        self.log("info", f"Avatar photo ready in {t} s: {path}")
        self._status("ready", "Ditto is animating the photo", animating=True)

    # ------------------------------------------------------------- commands --

    def _cmd_set_photo(self, msg):
        path = msg.get("path") or ""
        self.cfg["photo"] = path

        def work():
            with self._busy:
                if self.live is None:
                    return
                try:
                    if path and os.path.exists(path):
                        self._start_photo(path)
                    else:
                        self.live.stop()
                        self._status("ready", "No photo selected", animating=False)
                except Exception as exc:
                    traceback.print_exc()
                    self._status("error", f"Photo could not be animated: {exc}")
        threading.Thread(target=work, name="avatar-photo", daemon=True).start()

    def _cmd_play(self, msg):
        if self.live is None or not self.live.running:
            self.out.emit("speech_ended", turn_id=msg.get("turn_id"), seq=msg.get("seq"), reason="failed",
                          played_ms=0, tail_ms=0, detail="the avatar is not animating")
            return
        wav = base64.b64decode(msg["wav_b64"])
        self.live.play(msg.get("turn_id"), msg.get("seq"), wav)

    def _cmd_stop(self, msg):
        if self.live:
            self.live.stop_turn(msg.get("turn_id"), msg.get("reason") or "stopped")

    def _cmd_configure(self, msg):
        c = msg.get("config") or {}
        if "sharpen" in c and getattr(self, "accel", None):
            self.accel.PUTBACK["sharpen"] = float(c["sharpen"])   # takes effect on the next frame
        changed = any(c.get(k) != self.cfg.get(k) for k in ("output_device", "host_api"))
        self.cfg.update(c)
        if changed and self.live:
            notes = self.live.open_output(self.cfg.get("output_device", ""), self.cfg.get("host_api", "auto"))
            for n in notes:
                self.log("warning", n)
            self.log("info", f"Avatar audio output: {self.live.output_name}")

    def _cmd_get_stats(self, msg):
        info = self.live.info() if self.live else {}
        try:
            import torch
            info["torch_vram_mb"] = round(torch.cuda.max_memory_allocated() / 1048576)
        except Exception:
            pass
        info["mjpeg_clients"] = self.hub.clients if self.hub else 0
        self.out.emit("stats", reply_to=msg.get("id"), **info)

    def _cmd_record(self, msg):
        if not self.live:
            raise RuntimeError("not running")
        if msg.get("action") == "start":
            self.live.record_start()
            self.out.emit("record", reply_to=msg.get("id"), started=True)
        else:
            res = self.live.record_stop(msg.get("path"))
            self.out.emit("record", reply_to=msg.get("id"), result=res)
