"""Voice selection (VC-M1.2): the per-request voice of the Silero provider, the
logic of voice_smoke, and the reader of a model file's speaker list. No real
model here: voice_smoke.bat is what speaks with the installed one. These tests
prove that the checks can fail."""
import argparse
import hashlib
import io
import os
import pickle
import tempfile
import unittest
import zipfile

import numpy as np

from services.voice_service import model_speakers, voice_smoke
from services.voice_service.tts.silero_tts import SileroTts

SPEAKERS = ["aidar", "baya", "kseniya", "eugene", "xenia"]
PITCH = {"aidar": 110.0, "baya": 210.0, "kseniya": 190.0, "eugene": 125.0, "xenia": 230.0}


def tone(freq, sample_rate=48000, seconds=1.0, phase=0.0):
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    return (0.2 * np.sin(2 * np.pi * freq * t + phase) + 0.08 * np.sin(2 * np.pi * 2 * freq * t)).astype(np.float32)


class FakeVoiceTts:
    """A model with five speakers; each speaks at its own pitch."""

    def __init__(self, model_id, voice, device, threads, sample_rate, models_dir, language,
                 speakers=None, ignore_voice=False, accept_unknown=False, stale_voice=False, silent=None, reload_on_voice=False):
        self.model_id, self.voice, self.sample_rate, self.language = model_id, voice, sample_rate, language
        self.voices = list(speakers or SPEAKERS)
        self.ignore_voice, self.accept_unknown, self.stale_voice, self.silent = ignore_voice, accept_unknown, stale_voice, silent
        self.reload_on_voice = reload_on_voice
        self.model = object()
        self.calls = []

    def load(self):
        pass

    def describe(self):
        return {"provider": "fake", "model": self.model_id, "voice": self.voice, "voices": self.voices,
                "language": self.language, "device": "cpu", "sample_rate": self.sample_rate, "load_ms": 5.0, "warmup_ms": 1.0}

    def set_voice(self, voice):
        if voice not in self.voices:
            return False
        if not self.stale_voice:
            self.voice = voice
        if self.reload_on_voice:
            self.model = object()
        return True

    def synthesize(self, text, voice=None):
        if voice and voice not in self.voices and not self.accept_unknown:
            raise ValueError(f"voice '{voice}' is not available")
        speaker = self.voice if (self.ignore_voice or not voice or voice not in self.voices) else voice
        self.calls.append(speaker)
        if speaker == self.silent:
            return np.zeros(48000, dtype=np.float32)
        return tone(PITCH.get(speaker, 300.0), self.sample_rate)


class FakeOut:
    def __init__(self, sample_rate, on_event):
        self.on_event, self.device_name, self.host_api, self.latency_ms = on_event, "Fake Speakers", "fake", 12.0
        self.played = 0

    def open(self, device, host_api):
        return []

    def play(self, audio, tag):
        self.played += 1
        self.on_event("start", tag, 1000.0)
        self.on_event("end", tag, 2000.0)

    def close(self):
        pass


def args(**kw):
    base = dict(model_id="v5_5_ru", default_voice="xenia", expected=",".join(SPEAKERS), language="ru", device="cpu",
                threads=1, sample_rate=48000, models_dir="models", output_device="", host_api="auto",
                text="Привет. Это пример моего голоса.", wav_dir="", report="", play=False)
    base.update(kw)
    return argparse.Namespace(**base)


def run(a=None, **tts_kw):
    made = []

    def make(*positional):
        made.append(FakeVoiceTts(*positional, **tts_kw))
        return made[-1]

    report = voice_smoke.run_voice_smoke(a or args(), make_tts=make, make_output=FakeOut, say=lambda _m: None)
    return report, made


def failed(report):
    return [c["name"] for c in report["checks"] if not c["ok"]]


class VoiceSmokeLogicTest(unittest.TestCase):
    def test_five_distinct_speakers_pass_with_one_model_load(self):
        report, made = run()
        self.assertTrue(report["ok"], failed(report))
        self.assertEqual(report["speakers"], SPEAKERS)
        self.assertEqual(len(made), 1, "the model is created once")
        self.assertEqual(sorted(report["voices"]), sorted(SPEAKERS))
        for name, v in report["voices"].items():
            self.assertGreater(v["audio_ms"], 500.0, name)
            self.assertGreater(v["rms"], 0.005, name)
            self.assertEqual(len(v["sha256_pcm16"]), 64)
        self.assertEqual(len({v["sha256_pcm16"] for v in report["voices"].values()}), 5)
        d = report["distinctness"]
        self.assertTrue(d["same_speaker_repeat_identical_waveform"])
        self.assertGreater(d["smallest_between_speakers"], d["same_speaker_repeat"])
        self.assertTrue(report["unknown_voice"]["refused"])
        self.assertEqual((report["live_switch"]["from"], report["live_switch"]["to"]), ("xenia", "aidar"))
        self.assertTrue(report["live_switch"]["identical_to_explicit_selection"])
        self.assertFalse(report["live_switch"]["model_reloaded"])
        # every speaker was asked for by name, then xenia again, then the switched voice
        self.assertEqual(made[0].calls, SPEAKERS + ["xenia", "aidar"])
        self.assertEqual(made[0].voice, "xenia", "the configured voice is restored")

    def test_one_voice_under_five_names_is_caught(self):
        report, _ = run(ignore_voice=True)
        self.assertFalse(report["ok"])
        self.assertIn("Every speaker gives different audio", failed(report))
        self.assertIn("Different speakers differ more than two syntheses of the same speaker", failed(report))

    def test_an_unknown_voice_that_is_silently_replaced_is_caught(self):
        report, _ = run(accept_unknown=True)
        self.assertEqual(failed(report), ["An unknown voice is refused, not replaced"])

    def test_a_stale_configured_voice_is_caught(self):
        report, _ = run(stale_voice=True)
        self.assertEqual(failed(report), ["Switching the configured voice to aidar applies to the next synthesis"])

    def test_a_reload_on_voice_change_is_caught(self):
        report, _ = run(reload_on_voice=True)
        self.assertEqual(failed(report), ["Switching the configured voice to aidar applies to the next synthesis"])
        self.assertTrue(report["live_switch"]["model_reloaded"])

    def test_a_silent_speaker_is_caught(self):
        report, _ = run(silent="baya")
        self.assertIn("baya: audio produced and not silent", failed(report))

    def test_a_voice_list_that_differs_from_the_model_is_caught(self):
        report, _ = run(args(expected="xenia,baya,kseniya,aidar,eugene,natasha"))
        self.assertEqual(failed(report), ["The application offers exactly the model's speakers"])
        report, _ = run(speakers=["xenia", "baya"])
        self.assertEqual(failed(report), ["The application offers exactly the model's speakers"])
        self.assertEqual(report["speakers"], ["xenia", "baya"], "what the model reports is recorded as it is")

    def test_play_plays_every_sample_and_wavs_are_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, _ = run(args(play=True, wav_dir=tmp))
            self.assertTrue(report["ok"], failed(report))
            for name in SPEAKERS:
                self.assertTrue(report["voices"][name]["playback"]["completed"])
                self.assertTrue(os.path.isfile(os.path.join(tmp, f"voice_{name}.wav")))

    def test_an_exception_is_a_failed_report_not_a_crash(self):
        def boom(*_a):
            raise RuntimeError("model file missing (fake)")
        report = voice_smoke.run_voice_smoke(args(), make_tts=boom, say=lambda _m: None)
        self.assertFalse(report["ok"])
        self.assertIn("model file missing", report["error"])

    def test_spectrum_distance_separates_pitches_not_repeats(self):
        a = voice_smoke.average_spectrum(tone(110.0), 48000)
        b = voice_smoke.average_spectrum(tone(110.0, phase=1.0), 48000)
        c = voice_smoke.average_spectrum(tone(230.0), 48000)
        self.assertLess(voice_smoke.spectrum_distance(a, b), 0.5)
        self.assertGreater(voice_smoke.spectrum_distance(a, c), voice_smoke.spectrum_distance(a, b) * 5)


class FakeTensor:
    def __init__(self, data):
        self.data = data

    def detach(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.data


class FakeSileroModel:
    """Stands in for the torch.package model: records the speaker of every call."""
    speakers = ["aidar", "baya", "kseniya", "eugene", "xenia"]

    def __init__(self):
        self.calls = []

    def apply_tts(self, text, speaker, sample_rate, **kw):
        if speaker not in self.speakers:
            raise ValueError(f"`speaker` should be in {', '.join(self.speakers)}")
        self.calls.append((speaker, text, sample_rate))
        return FakeTensor(np.full(4800, 0.1, dtype=np.float32))


class SileroProviderVoiceTest(unittest.TestCase):
    """The real provider class with a stand-in model: how it chooses the speaker."""

    def make(self, voice="xenia"):
        tts = SileroTts("v5_5_ru", voice, "cpu", 1, 48000, "models", "ru")
        tts.model = FakeSileroModel()
        tts.voices = list(tts.model.speakers)
        return tts

    def test_the_speaker_is_passed_with_every_synthesis(self):
        tts = self.make()
        tts.synthesize("Привет.")
        tts.synthesize("Привет.", voice="aidar")
        tts.synthesize("Привет.")
        self.assertEqual([c[0] for c in tts.model.calls], ["xenia", "aidar", "xenia"], "a named voice applies to that call only")

    def test_changing_the_configured_voice_needs_no_reload(self):
        tts = self.make()
        model = tts.model
        self.assertTrue(tts.set_voice("kseniya"))
        tts.synthesize("Привет.")
        self.assertEqual(tts.model.calls[-1][0], "kseniya")
        self.assertIs(tts.model, model)
        self.assertFalse(tts.set_voice("natasha"))
        self.assertEqual(tts.voice, "kseniya", "an unknown voice does not change the configured one")

    def test_an_unknown_voice_is_an_error_not_a_fallback(self):
        tts = self.make()
        with self.assertRaises(ValueError) as ctx:
            tts.synthesize("Привет.", voice="natasha")
        self.assertIn("natasha", str(ctx.exception))
        self.assertIn("aidar, baya, kseniya, eugene, xenia", str(ctx.exception))
        self.assertEqual(tts.model.calls, [], "nothing was synthesized in another voice")

    def test_every_speaker_of_the_model_is_usable_regardless_of_gender(self):
        tts = self.make()
        for speaker in tts.voices:
            self.assertGreater(len(tts.synthesize("Привет.", voice=speaker)), 0)
        self.assertEqual([c[0] for c in tts.model.calls], ["aidar", "baya", "kseniya", "eugene", "xenia"])
        self.assertEqual(tts.describe()["voices"], ["aidar", "baya", "kseniya", "eugene", "xenia"])


if __name__ == "__main__":
    unittest.main()


# --------------------------------------------------------------------------
# model_speakers.py: the speaker list read from a model FILE without loading it
# --------------------------------------------------------------------------


class InnerPackage:
    """Shape of the inner package object of a Silero v5 model (attributes only)."""

    def __init__(self, table):
        self.speaker_to_ids = [table]
        self.speaker_to_model = {name: 0 for name in table}
        self.speakers = list(table)
        self.device = "cpu"


class OuterModel:
    def __init__(self, packages):
        self.packages = packages
        self.speaker_to_package = {s: i for i, p in enumerate(packages) for s in p.speakers}
        self.speakers = list(self.speaker_to_package)
        self.symbols = "abc"


MODEL_SOURCE = (
    "class Multi:\n"
    "    def apply_tts(self, text, speaker, sample_rate=48000):\n"
    "        assert sample_rate in [8000, 24000, 48000]\n"
    "        if speaker == 'random':\n"
    "            pass\n"
    "        raise ValueError(f\"`speaker` should be in {', '.join(self.speakers)}\")\n"
)


def write_package(path, model, member="pkg/tts_models/model", source=MODEL_SOURCE, extra=None):
    with zipfile.ZipFile(path, "w") as archive:
        if model is not None:
            archive.writestr(member, pickle.dumps(model, protocol=3))
        if source is not None:
            archive.writestr("pkg/multi_acc_v3_package.py", source)
        archive.writestr("pkg/.data/version", "1")
        for name, data in (extra or {}).items():
            archive.writestr(name, data)


class ExecutesOnLoad:
    """A pickle that would run code if it were unpickled normally."""

    def __reduce__(self):
        return (os.system, ("echo model_speakers executed code > " + ExecutesOnLoad.marker,))


class ModelSpeakersTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vvc-speakers-")
        self.path = os.path.join(self.dir, "model.pt")

    def test_speakers_are_read_from_the_file_in_the_models_own_order(self):
        table = {"aidar": 0, "baya": 1, "kseniya": 2, "eugene": 3, "xenia": 4}
        write_package(self.path, OuterModel([InnerPackage(table)]))
        result = model_speakers.inspect_model(self.path)
        self.assertEqual(result["speakers"], ["aidar", "baya", "kseniya", "eugene", "xenia"])
        self.assertEqual(result["speaker_to_package"], {name: 0 for name in table})
        self.assertEqual(result["packages"], [{"speakers": list(table), "speaker_to_ids": [table], "speaker_to_model": {name: 0 for name in table}}])
        self.assertEqual(result["archive"]["model_pickle"], "pkg/tts_models/model")
        self.assertEqual(result["source"], {"refuses_unknown_speaker": True, "has_random_voice_code_path": True, "sample_rates": [8000, 24000, 48000]})
        with open(self.path, "rb") as fh:
            self.assertEqual(result["file"], {"bytes": os.path.getsize(self.path), "sha256": hashlib.sha256(fh.read()).hexdigest()})

    def test_nothing_from_the_archive_is_executed_or_imported(self):
        ExecutesOnLoad.marker = os.path.join(self.dir, "executed.txt")
        model = OuterModel([InnerPackage({"one": 0, "two": 1})])
        model.payload = ExecutesOnLoad()
        write_package(self.path, model)
        result = model_speakers.inspect_model(self.path)
        self.assertEqual(result["speakers"], ["one", "two"])
        self.assertFalse(os.path.exists(ExecutesOnLoad.marker), "the pickle was read without running what it refers to")
        # the same bytes DO run code when unpickled the ordinary way: the test is meaningful
        with zipfile.ZipFile(self.path) as archive:
            pickle.loads(archive.read("pkg/tts_models/model"))
        self.assertTrue(os.path.exists(ExecutesOnLoad.marker))

    def test_classes_of_the_archive_are_never_resolved(self):
        write_package(self.path, OuterModel([InnerPackage({"one": 0})]))
        seen = []
        original = model_speakers._InertUnpickler.find_class

        def spy(self, module, name):
            seen.append((module, name))
            return original(self, module, name)

        model_speakers._InertUnpickler.find_class = spy
        try:
            model_speakers.inspect_model(self.path)
        finally:
            model_speakers._InertUnpickler.find_class = original
        self.assertTrue(seen)
        resolved = [original(model_speakers._InertUnpickler(io.BytesIO(b"")), m, n) for m, n in seen]
        self.assertTrue(all(c is model_speakers._Placeholder or c is dict for c in resolved))

    def test_a_model_without_the_outer_speaker_list_falls_back_to_the_inner_tables(self):
        model = OuterModel([InnerPackage({"x": 0, "y": 1})])
        del model.speakers
        write_package(self.path, model)
        self.assertEqual(model_speakers.inspect_model(self.path)["speakers"], ["x", "y"])

    def test_foreign_files_are_reported_not_guessed(self):
        write_package(self.path, None)
        with self.assertRaises(ValueError):
            model_speakers.inspect_model(self.path)
        with open(self.path, "wb") as fh:
            fh.write(b"this is not a zip archive")
        with self.assertRaises(zipfile.BadZipFile):
            model_speakers.inspect_model(self.path)
        # an object without any speaker information: no invented list
        write_package(self.path, {"nothing": "here"})
        self.assertIsNone(model_speakers.inspect_model(self.path)["speakers"])
