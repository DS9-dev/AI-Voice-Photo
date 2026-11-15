import argparse
import inspect
import io
import os
import ssl
import tempfile
import unittest
import zipfile

import numpy as np

from services.voice_service import tts_smoke
from services.voice_service.tts import model_store
from services.voice_service.tts.model_store import ModelInstallError


def make_model_bytes(extra=b""):
    """A structurally valid stand-in for a torch.package model file (> 1 MB)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("v5_5_ru/tts_models/model.pkl", os.urandom(1_100_000))
        z.writestr("v5_5_ru/.data/version", b"1" + extra)
    return buf.getvalue()


class FakeResponse:
    def __init__(self, data, announce=None):
        self._buf = io.BytesIO(data)
        self.headers = {"Content-Length": str(len(data) if announce is None else announce)}

    def read(self, n=-1):
        return self._buf.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Opener:
    def __init__(self, data, announce=None):
        self.data, self.announce, self.urls = data, announce, []

    def __call__(self, url, timeout=60.0):
        self.urls.append(url)
        return FakeResponse(self.data, self.announce), "test trust store"


class TlsPolicyTest(unittest.TestCase):
    def test_every_download_context_verifies_chain_and_host_name(self):
        contexts = model_store.trust_contexts()
        self.assertGreaterEqual(len(contexts), 1)
        for name, ctx in contexts:
            self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED, name)
            self.assertTrue(ctx.check_hostname, name)
        self.assertEqual(contexts[-1][0], "operating system store")

    def test_certifi_bundle_is_tried_first_when_installed(self):
        try:
            import certifi  # noqa: F401
        except ImportError:
            self.skipTest("certifi is not installed")
        self.assertTrue(model_store.trust_contexts()[0][0].startswith("certifi"))

    def test_download_path_contains_no_way_to_disable_verification(self):
        for fn in (model_store.trust_contexts, model_store._open_verified, model_store.download,
                   model_store.ensure_model, model_store.install_local):
            source = inspect.getsource(fn)
            for forbidden in ("CERT_NONE", "_create_unverified_context", "verify=False", "check_hostname = False"):
                self.assertNotIn(forbidden, source, f"{fn.__name__} must not contain {forbidden}")

    def test_plain_http_is_refused(self):
        with self.assertRaises(ModelInstallError):
            model_store._open_verified("http://models.silero.ai/models/tts/ru/v5_5_ru.pt")

    def test_model_url(self):
        self.assertEqual(model_store.MODEL_URL.format(language="ru", model_id="v5_5_ru"),
                         "https://models.silero.ai/models/tts/ru/v5_5_ru.pt")


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.models = self.dir.name
        self.path = os.path.join(self.models, "silero", "v5_5_ru.pt")

    def test_downloads_once_then_uses_the_local_file(self):
        opener = Opener(make_model_bytes())
        first = model_store.ensure_model("v5_5_ru", "ru", self.models, opener=opener)
        self.assertTrue(first["downloaded"])
        self.assertEqual(opener.urls, ["https://models.silero.ai/models/tts/ru/v5_5_ru.pt"])
        self.assertEqual(first["download"]["trust_store"], "test trust store")
        self.assertEqual(first["path"], self.path)
        self.assertTrue(first["is_zip"] and first["has_model_pickle"])
        self.assertEqual(first["lock"], "recorded")
        self.assertEqual(len(first["sha256"]), 64)
        self.assertTrue(os.path.isfile(self.path + ".sha256"))

        never = Opener(b"")
        second = model_store.ensure_model("v5_5_ru", "ru", self.models, opener=never)
        self.assertFalse(second["downloaded"])
        self.assertEqual(never.urls, [], "no network access once the model is installed")
        self.assertEqual(second["lock"], "verified")
        self.assertEqual(second["sha256"], first["sha256"])

    def test_truncated_download_is_rejected_and_leaves_nothing_behind(self):
        data = make_model_bytes()
        with self.assertRaises(ModelInstallError) as ctx:
            model_store.ensure_model("v5_5_ru", "ru", self.models, opener=Opener(data[:500_000], announce=len(data)))
        self.assertIn("cut off", str(ctx.exception))
        self.assertFalse(os.path.exists(self.path))
        self.assertFalse(os.path.exists(self.path + ".part"))

    def test_a_download_that_is_not_a_model_is_rejected(self):
        with self.assertRaises(ModelInstallError):
            model_store.ensure_model("v5_5_ru", "ru", self.models, opener=Opener(b"<html>error page</html>" * 100_000))
        self.assertFalse(os.path.exists(self.path))

    def test_file_changed_after_installation_is_detected(self):
        model_store.ensure_model("v5_5_ru", "ru", self.models, opener=Opener(make_model_bytes()))
        with open(self.path, "wb") as fh:
            fh.write(make_model_bytes(extra=b"tampered"))
        with self.assertRaises(ModelInstallError) as ctx:
            model_store.ensure_model("v5_5_ru", "ru", self.models, opener=Opener(b""))
        self.assertIn("changed since it was installed", str(ctx.exception))

    def test_pinned_digest_must_match(self):
        model_store.KNOWN_SHA256["v5_5_ru"] = "0" * 64
        self.addCleanup(model_store.KNOWN_SHA256.pop, "v5_5_ru", None)
        with self.assertRaises(ModelInstallError) as ctx:
            model_store.ensure_model("v5_5_ru", "ru", self.models, opener=Opener(make_model_bytes()))
        self.assertIn("known SHA-256", str(ctx.exception))

    def test_manual_installation_from_a_local_file(self):
        source = os.path.join(self.models, "downloaded-by-hand.pt")
        with open(source, "wb") as fh:
            fh.write(make_model_bytes())
        facts = model_store.install_local(source, "v5_5_ru", self.models)
        self.assertEqual(facts["path"], self.path)
        self.assertTrue(os.path.isfile(self.path))
        self.assertEqual(facts["lock"], "recorded")
        # afterwards the normal path finds it without any download
        never = Opener(b"")
        self.assertFalse(model_store.ensure_model("v5_5_ru", "ru", self.models, opener=never)["downloaded"])
        self.assertEqual(never.urls, [])

    def test_manual_installation_rejects_a_wrong_file(self):
        source = os.path.join(self.models, "not-a-model.pt")
        with open(source, "wb") as fh:
            fh.write(b"x" * 2_000_000)
        with self.assertRaises(ModelInstallError):
            model_store.install_local(source, "v5_5_ru", self.models)
        with self.assertRaises(ModelInstallError):
            model_store.install_local(os.path.join(self.models, "missing.pt"), "v5_5_ru", self.models)

    def test_diagnosis_never_raises(self):
        report = model_store.tls_diagnostics("127.0.0.1", port=9, timeout=1.0)
        self.assertIn("conclusion", report)
        self.assertTrue(all(v["ok"] is False for v in report["verification"]))


# ----------------------------------------------------------- smoke logic --

class FakeTts:
    def __init__(self, model_id, voice, device, threads, sample_rate, models_dir, language, silent=False, boom=False):
        self.model_id, self.voice, self.sample_rate, self.language = model_id, voice, sample_rate, language
        self.silent, self.boom = silent, boom
        self.install = {}

    def load(self):
        if self.boom:
            raise RuntimeError("model file missing (fake)")

    def describe(self):
        return {"model": self.model_id, "voice": "xenia", "voices": ["xenia", "baya", "aidar"],
                "female_voices": ["xenia", "baya"], "language": self.language, "device": "cpu",
                "load_ms": 10.0, "warmup_ms": 5.0}

    def synthesize(self, text):
        n = self.sample_rate * 2
        return np.zeros(n, dtype=np.float32) if self.silent else (0.2 * np.sin(np.arange(n) / 20.0)).astype(np.float32)


class FakeOut:
    def __init__(self, sample_rate, on_event):
        self.on_event, self.device_name, self.host_api, self.latency_ms = on_event, "Fake Speakers", "fake", 12.0
        self.closed = False

    def open(self, device, host_api):
        return []

    def play(self, audio, tag):
        self.on_event("start", tag, 1000.0)
        self.on_event("end", tag, 3000.0)

    def close(self):
        self.closed = True


def smoke_args(**kw):
    base = dict(model_id="v5_5_ru", voice="xenia", language="ru", device="cpu", threads=1, sample_rate=48000,
                models_dir="models", output_device="", host_api="auto", text="Привет!", wav="", report="",
                no_play=False, no_tls_check=True)
    base.update(kw)
    return argparse.Namespace(**base)


class SmokeLogicTest(unittest.TestCase):
    """The smoke test's own pass/fail logic, with a fake engine. The real model
    is only exercised by tts_smoke.bat on a machine that has it."""

    def run_smoke(self, args=None, **tts_kw):
        return tts_smoke.run_smoke(args or smoke_args(), make_tts=lambda *a: FakeTts(*a, **tts_kw),
                                   make_output=FakeOut, say=lambda _m: None)

    def test_pass_reports_times_voice_and_model(self):
        r = self.run_smoke()
        self.assertTrue(r["ok"], r["checks"])
        self.assertEqual((r["model"]["model"], r["model"]["voice"]), ("v5_5_ru", "xenia"))
        self.assertGreaterEqual(r["initialization"]["total_ms"], 0)
        self.assertEqual(r["initialization"]["of_which_model_load_ms"], 10.0)
        self.assertAlmostEqual(r["synthesis"]["audio_ms"], 2000.0)
        self.assertGreaterEqual(r["synthesis"]["synthesis_ms"], 0)
        self.assertTrue(r["playback"]["completed"])
        self.assertEqual(r["playback"]["played_ms"], 2000.0)

    def test_silent_audio_fails(self):
        r = self.run_smoke(silent=True)
        self.assertFalse(r["ok"])
        self.assertIn("Audio is not silent", [c["name"] for c in r["checks"] if not c["ok"]])

    def test_wrong_voice_fails(self):
        r = self.run_smoke(smoke_args(voice="kseniya"))
        self.assertFalse(r["ok"])
        self.assertIn("Configured voice is the one selected", [c["name"] for c in r["checks"] if not c["ok"]])

    def test_load_failure_is_reported_not_raised(self):
        r = self.run_smoke(boom=True)
        self.assertFalse(r["ok"])
        self.assertIn("model file missing", r["error"])

    def test_wav_file_is_real_audio(self):
        import wave
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "out.wav")
            r = self.run_smoke(smoke_args(wav=path, no_play=True))
            self.assertTrue(r["ok"], r["checks"])
            self.assertTrue(r["playback"]["skipped"])
            with wave.open(path, "rb") as w:
                self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth()), (48000, 1, 2))
                self.assertEqual(w.getnframes(), 96000)


if __name__ == "__main__":
    unittest.main()
