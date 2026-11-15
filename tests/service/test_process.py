"""Starts the real service process (without loading any model) and checks the
process-ownership contract.

On Windows a virtual environment's `python.exe` is a launcher: it starts the
real interpreter as a child process. The process a parent starts (launcher)
and the process that runs the service code are then two different processes
with two different pids. The service reports this explicitly in `hello`
(pid, parent_pid, ancestors, executable, via_launcher), and whoever starts it
must see BOTH processes gone afterwards.
"""
import json
import os
import subprocess
import sys
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import psutil
except Exception:  # pragma: no cover - psutil is a project requirement
    psutil = None


def pid_alive(pid):
    if psutil is not None:
        if not psutil.pid_exists(pid):
            return False
        try:
            return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
        except psutil.Error:
            return False
    try:  # POSIX fallback
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def wait_gone(pid, timeout=6.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.05)
    return not pid_alive(pid)


def this_interpreter_runs_through_a_launcher():
    """True when sys.executable is only a launcher for the real interpreter
    image this very test process runs in (Windows venv). None if unknown."""
    if psutil is None:
        return None
    try:
        image = psutil.Process().exe()
    except psutil.Error:
        return None
    try:
        return not os.path.samefile(image, sys.executable)
    except OSError:
        return os.path.normcase(image) != os.path.normcase(sys.executable)


def relation(started_pid, hello):
    if hello["pid"] == started_pid:
        return "direct"
    if hello["parent_pid"] == started_pid:
        return "launcher"
    if started_pid in hello.get("ancestors", []):
        return "descendant"
    return "unrelated"


class ServiceProcess:
    """One started service plus everything needed to prove it is gone again."""

    def __init__(self, command=None):
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen(command or [sys.executable, "-u", "-m", "services.voice_service"],
                                     cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
        self.hello = None

    def send(self, obj):
        self.proc.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def read_event(self):
        line = self.proc.stdout.readline()
        if not line:
            raise AssertionError("service closed stdout: " + self.proc.stderr.read().decode("utf-8", "replace")[-2000:])
        event = json.loads(line.decode("utf-8"))
        if event.get("event") == "hello":
            self.hello = event
        return event

    @property
    def pids(self):
        pids = {self.proc.pid}
        if self.hello:
            pids.add(self.hello["pid"])
        return pids

    def cleanup(self):
        """Never leave anything behind, whatever the test did. Returns the pids
        that had to be killed here (an empty list means the test left none)."""
        forced = []
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
            forced.append(self.proc.pid)
        for pid in self.pids:
            if pid_alive(pid) and psutil is not None:
                try:
                    psutil.Process(pid).kill()
                    forced.append(pid)
                except psutil.Error:
                    pass
        for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                pipe.close()
            except Exception:
                pass
        return forced


class ProcessTest(unittest.TestCase):
    def start(self, command=None):
        svc = ServiceProcess(command)
        self.addCleanup(svc.cleanup)
        return svc

    def assert_both_gone(self, svc):
        self.assertIsNotNone(svc.proc.poll(), "the started process is still running")
        for pid in svc.pids:
            self.assertTrue(wait_gone(pid), f"process {pid} is still running (orphan)")

    def test_process_identity_contract(self):
        """hello.pid is the service process; it is the started process itself,
        or (through a venv launcher) a child of it. Never something unrelated."""
        svc = self.start()
        hello = svc.read_event()
        self.assertEqual(hello["event"], "hello")
        self.assertEqual(hello["protocol"], 1)
        rel = relation(svc.proc.pid, hello)
        self.assertNotEqual(rel, "unrelated",
                            f"service pid {hello['pid']} (parent {hello['parent_pid']}) is not in the tree of started pid {svc.proc.pid}")

        through_launcher = this_interpreter_runs_through_a_launcher()
        if through_launcher is not None:
            # the service must describe its own situation correctly ...
            self.assertEqual(hello["via_launcher"], through_launcher)
            # ... and the pids must match that situation exactly
            if through_launcher:
                self.assertIn(rel, ("launcher", "descendant"))
                self.assertNotEqual(hello["pid"], svc.proc.pid)
                self.assertIn(svc.proc.pid, hello["ancestors"])
            else:
                self.assertEqual(rel, "direct")
                self.assertEqual(hello["pid"], svc.proc.pid)
            # what each pid really is
            started_image = psutil.Process(svc.proc.pid).exe()
            service_image = psutil.Process(hello["pid"]).exe()
            self.assertTrue(os.path.samefile(started_image, sys.executable) or rel == "direct",
                            f"started process image {started_image} is not {sys.executable}")
            self.assertEqual(os.path.normcase(service_image), os.path.normcase(psutil.Process().exe()),
                             "the service runs in the same interpreter image as this test")
            self.assertEqual(os.path.normcase(hello["executable"]), os.path.normcase(service_image))

        svc.send({"cmd": "shutdown"})
        self.assertEqual(svc.proc.wait(timeout=10), 0)
        self.assert_both_gone(svc)

    def test_hello_clock_sync_error_and_shutdown(self):
        svc = self.start()
        hello = svc.read_event()
        self.assertEqual(hello["event"], "hello")
        self.assertNotEqual(relation(svc.proc.pid, hello), "unrelated")
        svc.send({"cmd": "clock_sync", "id": 1})
        sync = svc.read_event()
        self.assertEqual((sync["event"], sync["reply_to"]), ("clock_sync", 1))
        svc.proc.stdin.write("не json\n".encode("utf-8"))
        svc.proc.stdin.flush()
        self.assertEqual(svc.read_event()["event"], "error")
        svc.send({"cmd": "nope", "id": 2})
        err = svc.read_event()
        self.assertEqual((err["event"], err["reply_to"]), ("error", 2))
        svc.send({"cmd": "shutdown"})
        self.assertEqual(svc.proc.wait(timeout=10), 0)
        self.assert_both_gone(svc)

    def test_exits_when_parent_closes_stdin(self):
        svc = self.start()
        self.assertEqual(svc.read_event()["event"], "hello")
        svc.proc.stdin.close()
        self.assertEqual(svc.proc.wait(timeout=10), 0)
        self.assert_both_gone(svc)

    def test_service_does_not_outlive_a_killed_started_process(self):
        """Kill the started process (the launcher, where there is one), then
        drop the pipe: the service process itself must go away."""
        svc = self.start()
        hello = svc.read_event()
        self.assertEqual(hello["event"], "hello")
        svc.proc.kill()
        svc.proc.wait(timeout=10)
        svc.proc.stdin.close()   # the service ends on stdin EOF even without its launcher
        self.assertTrue(wait_gone(hello["pid"]), f"service process {hello['pid']} survived as an orphan")
        self.assert_both_gone(svc)

    def test_stray_prints_do_not_corrupt_the_protocol_channel(self):
        code = (
            "import sys, runpy\n"
            "sys.argv=['x']\n"
            "import services.voice_service.service as s\n"
            "orig = s.VoiceService.hello\n"
            "def hello(self):\n"
            "    print('library noise on stdout')\n"
            "    orig(self)\n"
            "s.VoiceService.hello = hello\n"
            "runpy.run_module('services.voice_service', run_name='__main__')\n"
        )
        svc = self.start([sys.executable, "-u", "-c", code])
        self.assertEqual(svc.read_event()["event"], "hello")
        svc.proc.stdin.close()
        svc.proc.wait(timeout=10)
        self.assertIn(b"library noise on stdout", svc.proc.stderr.read())
        self.assert_both_gone(svc)


if __name__ == "__main__":
    unittest.main()
