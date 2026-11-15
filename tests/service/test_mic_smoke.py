"""Microphone smoke test logic with fake devices and fake engines.

These tests prove the procedure and its conclusions. They say nothing about
a real microphone: only mic_smoke.bat on the target PC does.
One test additionally runs the REAL Silero VAD on a real speech recording
when both are available (see speech_wav()).
"""
import argparse
import json
import os
import tempfile
import threading
import time
import unittest
import wave

import numpy as np

from services.voice_service import mic_smoke
from services.voice_service.audio.wavio import read_wav, read_wav_16k, resample, write_wav

from .fakes import FakeStt, FakeVad

RATE = 16000
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def speech_wav():
    """A recording with real speech, if one is available on this machine."""
    for path in (os.environ.get("VVC_TEST_SPEECH_WAV"), os.path.join(ROOT, "artifacts", "tmp", "tts_smoke.wav")):
        if path and os.path.isfile(path):
            return path
    return None


def tone(seconds, amplitude):
    return np.full(int(RATE * seconds), amplitude, dtype=np.float32)


FEED_SPEED = 50.0   # the fake microphone delivers audio this many times faster than real time

SPEECH = np.concatenate([tone(0.3, 0.0), tone(0.8, 0.5), tone(1.0, 0.0)])     # FakeVad: loud = speech
NOISE = tone(2.0, 0.03)                                                        # audible, never "speech"
SILENCE = tone(2.0, 0.0)


class FakeMic:
    """Delivers a prepared signal in 512-sample frames, then zeros, until closed."""

    opened = []

    def __init__(self, on_frame, signals, default, fail=None):
        self.on_frame = on_frame
        self.signals = signals
        self.default = default
        self.fail = fail or {}
        self.device_name = ""
        self.host_api = "Fake API"
        self.latency_ms = 12.0
        self._stop = threading.Event()
        self._thread = None
        self._frames = 0

    def open(self, device_name, host_api_pref):
        name = device_name or self.default
        FakeMic.opened.append(device_name)
        if name in self.fail:
            raise RuntimeError(self.fail[name])
        self.device_name = name
        signal = self.signals.get(name)

        def feed():
            # Paced by the clock at FEED_SPEED x real time, not by the length of a sleep:
            # on Windows no sleep is shorter than ~15.6 ms, and a fixed 0.5 ms sleep per frame
            # delivered 30x less audio there than on Linux (VC-M3.3: 5 tests failed on the PC).
            i = 0
            t0 = time.monotonic()
            frame_s = 512 / RATE
            while not self._stop.is_set():
                if signal is None:                       # a stream that never calls back
                    time.sleep(0.01)
                    continue
                due = int((time.monotonic() - t0) * FEED_SPEED / frame_s) + 1
                while self._frames < due and not self._stop.is_set():
                    frame = signal[i:i + 512]
                    if len(frame) < 512:
                        frame = np.zeros(512, dtype=np.float32)
                    self.on_frame(frame.copy(), 0.0)
                    self._frames += 1
                    i += 512
                time.sleep(0.0005)
        self._thread = threading.Thread(target=feed, daemon=True)
        self._thread.start()
        return []

    def stats(self):
        return {"device": self.device_name, "host_api": self.host_api, "sample_rate": RATE, "channels": 1,
                "input_latency_ms": self.latency_ms, "callbacks": self._frames, "frames": self._frames, "overflows": 0,
                "stream_active": True}

    def close(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1)


class FakeNative:
    """The device's "own format": returns a prepared (samples, channels) array."""

    def __init__(self, deps):
        self.deps = deps
        self.sample_rate = 0
        self.channels = 0

    def open(self, device_name, host_api_pref):
        name = device_name or self.deps.default
        if self.deps.native_error:
            raise RuntimeError(self.deps.native_error)
        rate, audio = self.deps.native.get(name, (RATE, None))
        if audio is None:                                   # default: the same signal the microphone delivers
            mono = self.deps.signals.get(name)
            audio = np.zeros((0, 1), dtype=np.float32) if mono is None else mono.reshape(-1, 1)
        self.sample_rate = rate
        self._audio = np.asarray(audio, dtype=np.float32)
        self.channels = self._audio.shape[1]
        self.deps.native_opened.append(device_name)

    def close(self):
        return self._audio


class FakeDeps(mic_smoke.Deps):
    def __init__(self, signals, default="Mic A", stt=None, vad=None, fail=None, inputs=None, native=None, native_error=None):
        self.signals = signals
        self.native = native or {}
        self.native_error = native_error
        self.native_opened = []
        self.default = default
        self.stt = stt or FakeStt(text="сегодня хорошая погода")
        self.vad = vad or FakeVad()
        self.fail = fail
        self.inputs = inputs if inputs is not None else [
            {"index": 1, "name": "Mic A", "channels": 2, "default_samplerate": 48000.0, "is_default": True},
            {"index": 3, "name": "Mic B", "channels": 1, "default_samplerate": 44100.0, "is_default": False},
            {"index": 5, "name": "Mic C", "channels": 2, "default_samplerate": 48000.0, "is_default": False},
        ]
        FakeMic.opened = []

    def list_devices(self, host_api):
        return {"host_api": "Fake API", "inputs": self.inputs, "outputs": []}

    def make_input(self, on_frame):
        return FakeMic(on_frame, self.signals, self.default, self.fail)

    def make_native(self):
        return FakeNative(self)

    def make_vad(self):
        return self.vad

    def make_stt(self, args):
        return self.stt


def make_args(tmp, **over):
    base = dict(input_device="", device="", host_api="auto", seconds=3.0, scan_seconds=0.15, no_scan=False,
                no_native=False, native_wav=os.path.join(tmp, "native.wav"),
                stt_model="small", stt_device="cpu", compute_type="int8", language="ru", beam_size=1, models_dir="models",
                vad_threshold=0.5, min_speech_ms=100.0, min_silence_ms=200.0, speech_pad_ms=64.0, max_utterance_sec=10.0,
                sentence="Проверка.", self_check_wav=os.path.join(tmp, "missing.wav"),
                wav=os.path.join(tmp, "mic.wav"), report=os.path.join(tmp, "mic.json"))
    base.update(over)
    return argparse.Namespace(**base)


def run(deps, **over):
    tmp = tempfile.mkdtemp(prefix="vvc-mic-")
    lines = []
    report = mic_smoke.run_smoke(make_args(tmp, **over), deps=deps, say=lines.append)
    return report, "\n".join(lines), tmp


def checks(report):
    return {c["name"]: c for c in report["checks"]}


class MicSmokeTest(unittest.TestCase):
    def test_speech_on_the_selected_microphone_passes_and_everything_is_recorded(self):
        report, out, tmp = run(FakeDeps({"Mic A": SPEECH}))
        self.assertTrue(report["ok"], [c for c in report["checks"] if not c["ok"]])
        self.assertEqual(report["conclusion"]["code"], "ok")
        self.assertEqual(report["selection"]["device"], "Mic A")
        self.assertEqual(report["selection"]["index"], 1)
        self.assertEqual(report["selection"]["host_api"], "Fake API")
        self.assertEqual(report["selection"]["configured_device_missing"], False)
        self.assertEqual([d["name"] for d in report["devices"]["inputs"]], ["Mic A", "Mic B", "Mic C"])
        self.assertEqual(FakeMic.opened, [""], "empty configuration opens the default device, exactly like the application")
        self.assertEqual(report["level"]["signal"], "ok")
        self.assertAlmostEqual(report["level"]["peak"], 0.5, places=3)
        self.assertGreater(report["level"]["frames"], 25)
        self.assertEqual(report["capture"]["stream"]["sample_rate"], 16000)
        self.assertEqual(report["capture"]["stream"]["channels"], 1)
        self.assertEqual(report["vad"]["speech_starts"], 1)
        self.assertEqual(report["vad"]["speech_ends"], 1)
        self.assertAlmostEqual(report["vad"]["speech_ms"], 800.0, delta=33)
        self.assertGreaterEqual(report["vad"]["end_detected_after_silence_ms"], 200.0)
        self.assertEqual(report["stt"]["text"], "сегодня хорошая погода")
        self.assertTrue(report["stt"]["accepted"])
        self.assertGreater(report["stt"]["audio_ms"], 800)
        self.assertNotIn("scan", report, "other devices are not touched when the selected one works")
        self.assertIn("<- system default, USED BY THE APPLICATION", out.replace("Windows default", "system default"))
        self.assertIn("candidate OPENED", out)
        self.assertIn("utterance COMPLETE: 832 ms of speech", out)   # 0.8 s of sound, not frame-aligned: 26 frames
        self.assertEqual(len(report["vad"]["candidates"]), 1)
        self.assertEqual(report["vad"]["candidates"][0]["outcome"], "completed")
        self.assertEqual(report["vad"]["candidates"][0]["speech_ms"], report["vad"]["speech_ms"])
        self.assertEqual(report["vad"]["in_speech_when_listening_stopped"], False)
        self.assertEqual(report["vad"]["frame_ms"], 32.0)
        self.assertEqual(len(report["vad"]["frame_probs"]), report["level"]["frames"])
        self.assertEqual(FakeMic.opened, [""])
        self.assertEqual(report["native_capture"]["recorded"], True)
        # the recording is a real WAV with the captured audio
        audio, rate = read_wav(report["wav"])
        self.assertEqual(rate, 16000)
        self.assertAlmostEqual(float(np.max(np.abs(audio))), 0.5, places=2)
        json.dumps(report)   # everything in the report is serializable

    def test_a_silent_device_fails_and_the_other_devices_are_measured_but_not_selected(self):
        report, out, tmp = run(FakeDeps({"Mic A": SILENCE, "Mic B": NOISE, "Mic C": SILENCE}), seconds=0.3)
        self.assertFalse(report["ok"])
        self.assertEqual(report["conclusion"]["code"], "digital_silence")
        self.assertIn("Privacy & security → Microphone", report["conclusion"]["text"])
        self.assertIn("For comparison, a signal was measured on: Mic B. Nothing was changed.", report["conclusion"]["text"])
        self.assertEqual(report["level"]["peak"], 0.0)
        self.assertEqual(report["level"]["peak_dbfs"], "-inf dBFS")
        self.assertGreater(report["level"]["frames"], 0)
        c = checks(report)
        self.assertTrue(c["Input stream opened"]["ok"])
        self.assertTrue(c["Audio frames received from the device"]["ok"])
        self.assertFalse(c["Captured audio is not silent"]["ok"])
        self.assertIn("every sample is zero", c["Captured audio is not silent"]["detail"])
        self.assertFalse(any("saw speech" in name or "candidate" in name or "End of speech" in name for name in c),
                         "no claims about speech on a silent recording")
        self.assertEqual({e["device"]: e["signal"] for e in report["scan"]}, {"Mic B": "ok", "Mic C": "digital_silence"})
        self.assertEqual(report["selection"]["device"], "Mic A", "the selection is reported, never changed")
        self.assertEqual(FakeMic.opened, ["", "Mic B", "Mic C"])
        self.assertIn("comparison only: the selected microphone and all settings are unchanged", out)
        self.assertNotIn("To use one of them", out, "a silent run is not treated as a wrong device selection")
        self.assertEqual(self._stt_calls(report), 0)

    def _stt_calls(self, report):
        return 1 if "stt" in report else 0

    def test_sound_without_speech_is_not_called_silence(self):
        deps = FakeDeps({"Mic A": NOISE}, stt=FakeStt(text=""))
        report, out, tmp = run(deps, seconds=0.4)
        self.assertFalse(report["ok"])
        self.assertEqual(report["conclusion"]["code"], "no_speech_detected")
        c = checks(report)
        self.assertTrue(c["Captured audio is not silent"]["ok"])
        saw = c["Silero VAD saw speech (a frame at or above the threshold)"]
        self.assertFalse(saw["ok"])
        self.assertIn("highest speech probability 0.00", saw["detail"])
        self.assertIn("whisper_on_whole_recording_diagnostic", report)
        self.assertNotIn("stt", report, "the diagnostic transcription is not reported as a result")
        self.assertNotIn("scan", report)

    def test_speech_that_never_ends_is_reported_as_such(self):
        # the fake delivers frames much faster than real time: make the sound outlast the listening period
        report, out, tmp = run(FakeDeps({"Mic A": tone(120.0, 0.5)}), seconds=0.3, max_utterance_sec=1000.0)
        self.assertEqual(report["conclusion"]["code"], "speech_not_finished")
        self.assertFalse(checks(report)["End of speech detected"]["ok"])
        self.assertTrue(report["vad"]["in_speech_when_listening_stopped"])
        self.assertEqual(report["vad"]["candidates"][-1]["outcome"], "open_when_listening_stopped")
        self.assertGreater(report["vad"]["final_state"]["candidate_ms"], 1000.0)

    def test_a_transcript_the_application_would_discard_fails(self):
        report, out, tmp = run(FakeDeps({"Mic A": SPEECH}, stt=FakeStt(text="Продолжение следует...")))
        self.assertFalse(report["ok"])
        self.assertEqual(report["conclusion"]["code"], "stt_discarded")
        self.assertEqual(report["stt"]["filter"], "known_hallucination")

    def test_whisper_returning_nothing_fails(self):
        report, out, tmp = run(FakeDeps({"Mic A": SPEECH}, stt=FakeStt(text="")))
        self.assertEqual(report["conclusion"]["code"], "stt_no_text")

    def test_stream_that_cannot_be_opened(self):
        report, out, tmp = run(FakeDeps({"Mic A": SPEECH}, fail={"Mic A": "Invalid device [PaErrorCode -9996]"}), no_scan=True)
        self.assertFalse(report["ok"])
        self.assertEqual(report["conclusion"]["code"], "stream_failed")
        self.assertIn("-9996", checks(report)["Input stream opened"]["detail"])

    def test_stream_that_opens_but_never_delivers_frames(self):
        report, out, tmp = run(FakeDeps({"Mic A": None, "Mic B": SILENCE, "Mic C": SILENCE}), seconds=0.25)
        self.assertEqual(report["conclusion"]["code"], "no_frames")
        self.assertFalse(checks(report)["Audio frames received from the device"]["ok"])
        self.assertIn("No other input device carried a signal during the comparison.", report["conclusion"]["text"])

    def test_a_device_that_could_not_be_opened_during_the_scan_is_not_given_a_level(self):
        class FallbackMic(FakeMic):
            def open(self, device_name, host_api_pref):
                notes = super().open("" if device_name == "Mic C" else device_name, host_api_pref)   # falls back to the default
                return notes
        deps = FakeDeps({"Mic A": SILENCE, "Mic B": SILENCE, "Mic C": NOISE})
        deps.make_input = lambda on_frame: FallbackMic(on_frame, deps.signals, deps.default, deps.fail)
        report, out, tmp = run(deps, seconds=0.25)
        by_name = {e["device"]: e for e in report["scan"]}
        self.assertEqual(by_name["Mic C"]["signal"], "not_opened")
        self.assertIsNone(by_name["Mic C"]["peak"])
        self.assertIn("opened 'Mic A' instead", by_name["Mic C"]["error"])
        self.assertIn("No other input device carried a signal during the comparison.", report["conclusion"]["text"])

    def test_no_input_devices_at_all(self):
        report, out, tmp = run(FakeDeps({}, inputs=[]))
        self.assertEqual(report["conclusion"]["code"], "no_input_device")

    def test_configured_microphone_is_used_and_a_missing_one_is_reported(self):
        report, out, tmp = run(FakeDeps({"Mic A": SILENCE, "Mic B": SPEECH}), input_device="Mic B")
        self.assertTrue(report["ok"])
        self.assertEqual(report["selection"]["device"], "Mic B")
        self.assertEqual(FakeMic.opened, ["Mic B"])
        self.assertIn("application configuration", report["selection"]["source"])

        gone, out, tmp = run(FakeDeps({"Mic A": SPEECH}), input_device="Unplugged Headset")
        self.assertEqual(gone["selection"]["configured_device_missing"], True)
        self.assertEqual(gone["selection"]["device"], "Mic A")
        self.assertTrue(any("does not exist any more" in w for w in gone["warnings"]))

    def test_device_override_tests_another_device_without_changing_anything(self):
        report, out, tmp = run(FakeDeps({"Mic A": SILENCE, "Mic C": SPEECH}), device="Mic C")
        self.assertTrue(report["ok"])
        self.assertEqual(report["selection"]["device"], "Mic C")
        self.assertEqual(report["selection"]["source"], "--device override")
        self.assertTrue(any("configuration is not changed" in w for w in report["warnings"]))

    def test_self_check_runs_a_known_recording_through_vad_and_stt_without_the_microphone(self):
        tmp = tempfile.mkdtemp(prefix="vvc-mic-")
        known = os.path.join(tmp, "known.wav")
        write_wav(known, np.concatenate([tone(0.2, 0.0), tone(0.6, 0.5), tone(0.5, 0.0)]), RATE)
        deps = FakeDeps({"Mic A": SILENCE}, stt=FakeStt(text="привет это проверка"))
        lines = []
        report = mic_smoke.run_smoke(make_args(tmp, self_check_wav=known, seconds=0.25, no_scan=True), deps=deps, say=lines.append)
        c = checks(report)
        self.assertTrue(c["Self-check: VAD and Whisper recognize a known speech recording"]["ok"])
        self.assertEqual(report["self_check"]["stt"]["text"], "привет это проверка")
        self.assertEqual(report["conclusion"]["code"], "digital_silence",
                         "models work, microphone silent: the two are told apart")

    # ------------------------------------------------------------------
    # The target-PC run of 2026-10-06: ONE frame reached the VAD threshold,
    # then quiet noise, then digital silence. The first version of this
    # script reported that as "speech_not_finished".
    # ------------------------------------------------------------------
    def one_blip(self):
        return np.concatenate([tone(1.6, 0.003), tone(0.032, 0.5), tone(1.2, 0.003), tone(12.0, 0.0)])

    def test_one_short_sound_then_silence_is_not_reported_as_unfinished_speech(self):
        report, out, tmp = run(FakeDeps({"Mic A": self.one_blip()}), seconds=0.5,
                               min_speech_ms=250.0, min_silence_ms=600.0, speech_pad_ms=200.0)
        v = report["vad"]
        self.assertEqual(report["conclusion"]["code"], "only_short_sounds")
        self.assertIn("went back to listening", report["conclusion"]["text"])
        self.assertEqual(v["frames_over_threshold"], 1)
        self.assertEqual(v["speech_starts"], 1)
        self.assertEqual(v["discarded_short"], 1)
        self.assertEqual(v["speech_ends"], 0)
        self.assertEqual(v["in_speech_when_listening_stopped"], False)
        self.assertEqual(v["final_state"]["in_speech"], False)
        self.assertIsNone(v["final_state"]["candidate_start_ms"])
        self.assertEqual(v["candidates"], [{"start_ms": 1600.0, "speech_ms": 32.0, "outcome": "discarded_too_short", "decided_at_ms": 2240.0}])
        c = checks(report)
        self.assertTrue(c["Silero VAD saw speech (a frame at or above the threshold)"]["ok"])
        self.assertFalse(c["A speech candidate lasted at least 250 ms"]["ok"])
        self.assertIn("32 ms (discarded too short)", c["A speech candidate lasted at least 250 ms"]["detail"])
        self.assertNotIn("End of speech detected", c, "no claim that speech was still going on")
        self.assertIn("candidate DISCARDED: 32 ms of speech is below the 250 ms minimum — back to listening", out)
        self.assertNotIn("still going on", out + json.dumps(report))

    def test_the_trace_shows_the_state_before_and_after_the_discard(self):
        report, out, tmp = run(FakeDeps({"Mic A": self.one_blip()}), seconds=0.5,
                               min_speech_ms=250.0, min_silence_ms=600.0, speech_pad_ms=200.0)
        opened, discarded = report["vad"]["transitions"]
        self.assertEqual(opened["events"][0]["type"], "speech_start")
        self.assertEqual(opened["before"]["in_speech"], False)
        self.assertEqual(opened["after"], {**opened["after"], "in_speech": True, "candidate_start_ms": 1600.0, "candidate_ms": 32.0, "silence_ms": 0.0})
        self.assertEqual(discarded["events"][0]["type"], "speech_discarded")
        self.assertEqual(discarded["events"][0]["speech_ms"], 32.0)
        self.assertEqual(discarded["before"], {**discarded["before"], "in_speech": True, "candidate_start_ms": 1600.0, "candidate_ms": 32.0, "silence_ms": 608.0})
        self.assertEqual(discarded["after"], {"in_speech": False, "utterance_id": None, "candidate_start_ms": None, "candidate_ms": 0.0,
                                              "silence_ms": 0.0, "frames_buffered": 0, "pre_roll_frames": 0})
        self.assertEqual(discarded["t_ms"] - opened["t_ms"], 608.0)       # 600 ms of silence, rounded up to whole 32 ms frames
        self.assertEqual(discarded["frame"] - opened["frame"], 19)

    def test_a_valid_utterance_after_a_discarded_sound_is_still_recognized(self):
        signal = np.concatenate([tone(0.32, 0.0), tone(0.032, 0.5), tone(0.992, 0.0), tone(0.8, 0.5), tone(1.0, 0.0)])   # frame-aligned
        report, out, tmp = run(FakeDeps({"Mic A": signal}), min_speech_ms=250.0, min_silence_ms=600.0, speech_pad_ms=200.0)
        self.assertTrue(report["ok"], [c for c in report["checks"] if not c["ok"]])
        self.assertEqual([c["outcome"] for c in report["vad"]["candidates"]], ["discarded_too_short", "completed"])
        self.assertEqual(report["vad"]["speech_ms"], 800.0)

    def test_gated_microphone_is_described_by_when_sound_arrived(self):
        report, out, tmp = run(FakeDeps({"Mic A": self.one_blip()}), seconds=0.6, min_speech_ms=250.0, min_silence_ms=600.0)
        level = report["level"]
        self.assertGreater(level["zero_share"], 0.5)
        self.assertEqual(level["first_sound_s"], 0.0)
        self.assertAlmostEqual(level["last_sound_s"], 2.83, delta=0.05)
        self.assertTrue(any("exact zeros" in w and "gated or muted at the source" in w for w in report["warnings"]))
        self.assertEqual(level["signal"], "ok", "sound did arrive; this is not the 'no signal' case")
        self.assertNotIn("scan", report)

    # ----------------------------------------------- native-format capture
    def test_voice_in_one_native_channel_only_is_found(self):
        speech = SPEECH
        native = np.stack([np.zeros_like(speech), speech], axis=1)                 # voice only in channel 2
        deps = FakeDeps({"Mic A": NOISE}, native={"Mic A": (RATE, native)}, stt=FakeStt(text="голос есть"))
        report, out, tmp = run(deps, seconds=0.4)
        self.assertFalse(report["ok"])
        self.assertEqual(report["conclusion"]["code"], "no_speech_detected")
        self.assertTrue(report["conclusion"]["native_signal_has_speech"])
        self.assertIn("DOES contain an utterance (channel 2)", report["conclusion"]["text"])
        n = report["native_capture"]
        self.assertEqual((n["sample_rate"], n["channels"]), (RATE, 2))
        by_name = {v["name"]: v for v in n["variants"]}
        self.assertEqual(by_name["channel 1"]["utterances"], 0)
        self.assertEqual(by_name["channel 2"]["utterances"], 1)
        self.assertEqual(n["whisper_diagnostic"]["variant"], "channel 2")
        self.assertEqual(n["whisper_diagnostic"]["text"], "голос есть")
        self.assertNotIn("stt", report, "a diagnostic transcription never turns FAIL into PASS")
        audio, rate = read_wav(n["wav"])
        self.assertEqual(rate, RATE)
        json.dumps(report)

    def test_channels_in_opposite_phase_are_recognized(self):
        native = np.stack([SPEECH, -SPEECH], axis=1)                               # a mono mix cancels to zero
        report, out, tmp = run(FakeDeps({"Mic A": SILENCE}, native={"Mic A": (RATE, native)}), seconds=0.3, no_scan=True)
        n = report["native_capture"]
        by_name = {v["name"]: v for v in n["variants"]}
        self.assertEqual(n["channel_correlation"], -1.0)
        self.assertEqual(by_name["mono mix (mean of channels)"]["peak"], 0.0)
        self.assertEqual(by_name["difference (ch1 - ch2)/2"]["utterances"], 1)
        self.assertIn("opposite phase: a mono mix cancels the signal", out)
        self.assertTrue(report["conclusion"]["native_signal_has_speech"])
        self.assertEqual(report["conclusion"]["code"], "digital_silence")

    def test_native_signal_without_speech_confirms_the_device_delivered_none(self):
        blip = self.one_blip()
        native48 = np.repeat(np.stack([blip, blip], axis=1), 3, axis=0)            # the same thing at 48 kHz, 2 channels
        report, out, tmp = run(FakeDeps({"Mic A": blip}, native={"Mic A": (48000, native48)}), seconds=0.5,
                               min_speech_ms=250.0, min_silence_ms=600.0)
        self.assertEqual(report["conclusion"]["code"], "only_short_sounds")
        self.assertEqual(report["conclusion"]["native_signal_has_speech"], False)
        self.assertIn("native signal recorded at the same time (48000 Hz, 2 channel(s)) contains no utterance either", report["conclusion"]["text"])
        self.assertEqual(report["native_capture"]["channel_correlation"], 1.0)
        self.assertTrue(all(v["utterances"] == 0 for v in report["native_capture"]["variants"]))

    def test_native_recording_failure_does_not_disturb_the_test(self):
        report, out, tmp = run(FakeDeps({"Mic A": SPEECH}, native_error="Invalid sample rate [PaErrorCode -9997]"))
        self.assertTrue(report["ok"])
        self.assertEqual(report["native_capture"]["recorded"], False)
        self.assertIn("-9997", report["native_capture"]["error"])
        off, out, tmp = run(FakeDeps({"Mic A": SPEECH}), no_native=True)
        self.assertNotIn("native_capture", off)

    def test_native_recording_uses_the_same_device_as_the_application_stream(self):
        deps = FakeDeps({"Mic A": SILENCE, "Mic B": SPEECH})
        report, out, tmp = run(deps, input_device="Mic B")
        self.assertEqual(FakeMic.opened, ["Mic B"])
        self.assertEqual(deps.native_opened, ["Mic B"])

    def test_meter_and_decibels(self):
        self.assertEqual(mic_smoke._meter(0.0), "." * 20)
        self.assertEqual(mic_smoke._meter(1.0), "#" * 20)
        self.assertEqual(mic_smoke._meter(0.001), "." * 20)          # -60 dBFS
        self.assertEqual(mic_smoke._dbfs(0.0), "-inf dBFS")
        self.assertEqual(mic_smoke._dbfs(0.1), "-20.0 dBFS")


class WavHelpersTest(unittest.TestCase):
    def test_roundtrip_and_resampling(self):
        tmp = tempfile.mkdtemp(prefix="vvc-wav-")
        t = np.arange(48000) / 48000.0
        sine = (0.5 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
        path = os.path.join(tmp, "a.wav")
        write_wav(path, sine, 48000)
        audio, rate = read_wav(path)
        self.assertEqual(rate, 48000)
        self.assertEqual(len(audio), 48000)
        down = read_wav_16k(path)
        self.assertAlmostEqual(len(down) / 16000.0, 1.0, places=2)
        # still a 440 Hz tone of the same level
        spectrum = np.abs(np.fft.rfft(down))
        self.assertAlmostEqual(float(np.argmax(spectrum)) * 16000.0 / len(down), 440.0, delta=2.0)
        self.assertAlmostEqual(float(np.max(np.abs(down[1000:-1000]))), 0.5, delta=0.02)
        self.assertEqual(len(resample(sine, 48000, 48000)), 48000)

    def test_stereo_is_mixed_down_and_other_formats_are_rejected(self):
        tmp = tempfile.mkdtemp(prefix="vvc-wav-")
        path = os.path.join(tmp, "s.wav")
        with wave.open(path, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(np.array([[16384, 0]] * 100, dtype="<i2").tobytes())
        audio, rate = read_wav(path)
        self.assertEqual(len(audio), 100)
        self.assertAlmostEqual(float(audio[0]), 0.25, places=3)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(1)
            w.setframerate(16000)
            w.writeframes(bytes(100))
        with self.assertRaises(ValueError):
            read_wav(path)


try:
    from services.voice_service.vad.silero_onnx import SileroVadOnnx, find_model_path
    REAL_VAD = find_model_path()
except Exception:  # onnxruntime or silero-vad missing
    REAL_VAD = None


@unittest.skipIf(REAL_VAD is None or speech_wav() is None,
                 "needs the Silero VAD model and a speech recording (artifacts/tmp/tts_smoke.wav from tts_smoke.bat, or VVC_TEST_SPEECH_WAV)")
class RealVadOnRealSpeechTest(unittest.TestCase):
    """REAL Silero VAD on a real speech recording, fed through the microphone path of the smoke test."""

    def test_real_speech_through_the_capture_path_is_detected_and_segmented(self):
        speech = np.concatenate([np.zeros(RATE // 2, dtype=np.float32), read_wav_16k(speech_wav()), np.zeros(RATE * 2, dtype=np.float32)])
        deps = FakeDeps({"Mic A": speech}, vad=SileroVadOnnx(REAL_VAD), stt=FakeStt(text="привет это проверка синтеза речи"))
        tmp = tempfile.mkdtemp(prefix="vvc-mic-")
        report = mic_smoke.run_smoke(make_args(tmp, seconds=20.0, min_speech_ms=250.0, min_silence_ms=600.0, speech_pad_ms=200.0,
                                               self_check_wav=speech_wav()), deps=deps, say=lambda s: None)
        c = checks(report)
        self.assertTrue(c["Silero VAD saw speech (a frame at or above the threshold)"]["ok"], c)
        self.assertTrue(c["End of speech detected"]["ok"], c)
        self.assertGreater(report["vad"]["max_speech_prob"], 0.9)
        self.assertGreater(report["vad"]["speech_ms"], 1000.0)
        self.assertGreaterEqual(report["vad"]["end_detected_after_silence_ms"], 600.0)
        self.assertTrue(c["Self-check: VAD and Whisper recognize a known speech recording"]["ok"])
        self.assertGreater(report["self_check"]["max_speech_prob"], 0.9)
        self.assertTrue(report["ok"])


if __name__ == "__main__":
    unittest.main()
