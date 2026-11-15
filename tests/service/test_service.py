import threading
import time
import unittest

import numpy as np

from services.voice_service.clock import now_ms

from .fakes import LOUD, QUIET, FakeFactories, FakeStt, FakeTts, make_service

CONFIG = {
    "language": "ru",
    "stt": {"model": "small", "device": "cpu", "computeType": "int8", "language": "ru", "beamSize": 1},
    "tts": {"modelId": "fake", "voice": "xenia", "device": "cpu", "threads": 1, "sampleRate": 48000, "language": "ru"},
    "vad": {"threshold": 0.5, "minSpeechMs": 100, "minSilenceMs": 200, "speechPadMs": 64, "maxUtteranceSec": 10},
    "audio": {"hostApi": "auto", "inputDevice": "", "outputDevice": "", "listenResumeDelayMs": 0},
}


def init(service, stream, config=CONFIG):
    service.handle({"cmd": "init", "config": config})
    stream.wait_for(lambda e: e["event"] == "status" and e["component"] == "stt" and e["state"] in ("ready", "error"))


def speak_utterance(factories, t0=None, speech_frames=10, silence_frames=10):
    """Simulate microphone frames: speech then silence. Returns time after the last frame."""
    t = now_ms() + 5 if t0 is None else t0
    for _ in range(speech_frames):
        t += 32
        factories.audio_in.on_frame(LOUD, t)
    for _ in range(silence_frames):
        t += 32
        factories.audio_in.on_frame(QUIET, t)
    return t


class ServiceLifecycleTest(unittest.TestCase):
    def test_init_reports_every_component_ready(self):
        service, stream, _ = make_service()
        init(service, stream)
        ready = {e["component"] for e in stream.events("status") if e["state"] == "ready"}
        self.assertEqual(ready, {"output", "vad", "mic", "tts", "stt"})

    def test_one_component_failing_does_not_block_the_others(self):
        service, stream, _ = make_service(FakeFactories(stt=FakeStt(load_fail=True)))
        init(service, stream)
        states = {}
        for e in stream.events("status"):
            states[e["component"]] = e["state"]
        self.assertEqual(states["stt"], "error")
        self.assertEqual(states["tts"], "ready")
        self.assertEqual(states["mic"], "ready")
        err = [e for e in stream.events("status") if e["component"] == "stt" and e["state"] == "error"][0]
        self.assertIn("cuda unavailable", err["detail"])

    def test_unknown_and_malformed_commands_produce_errors_not_crashes(self):
        service, stream, _ = make_service()
        service.handle({"cmd": "does_not_exist", "id": 7})
        e = stream.wait_for(lambda e: e["event"] == "error")
        self.assertEqual(e["reply_to"], 7)
        service.handle({"cmd": "_malformed", "raw": "{oops"})
        self.assertEqual(len(stream.events("error")), 2)

    def test_clock_sync_and_devices_and_resources_reply(self):
        service, stream, _ = make_service()
        service.handle({"cmd": "clock_sync", "id": 1})
        e = stream.wait_for(lambda e: e["event"] == "clock_sync")
        self.assertEqual(e["reply_to"], 1)
        self.assertAlmostEqual(e["service_now_ms"], now_ms(), delta=500)
        service.handle({"cmd": "list_devices", "id": 2})
        d = stream.wait_for(lambda e: e["event"] == "devices")
        self.assertEqual(d["inputs"][0]["name"], "Fake Mic")
        service.handle({"cmd": "get_resources", "id": 3})
        r = stream.wait_for(lambda e: e["event"] == "resources")
        self.assertEqual(r["rss_mb"], 123.0)

    def test_shutdown_closes_devices_and_reports_stopped(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "shutdown"})
        self.assertTrue(service.stopped)
        self.assertTrue(factories.audio_in.closed)
        self.assertTrue(stream.events("bye"))


class MicrophonePathTest(unittest.TestCase):
    def test_frames_are_ignored_until_listening_is_enabled(self):
        service, stream, factories = make_service()
        init(service, stream)
        speak_utterance(factories)
        time.sleep(0.1)
        self.assertEqual(stream.events("speech_start"), [])
        self.assertEqual(factories.stt.calls, 0)

    def test_utterance_flows_to_transcript_with_ordered_timestamps(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        speak_utterance(factories)
        final = stream.wait_for(lambda e: e["event"] == "stt_final")
        end = stream.events("speech_end")[0]
        self.assertEqual(final["text"], "привет как дела")
        self.assertEqual(final["utterance_id"], end["utterance_id"])
        self.assertLess(end["t_speech_start"], end["t_speech_end"])
        self.assertGreaterEqual(end["t_vad_end_detected"] - end["t_speech_end"], 200)
        self.assertGreaterEqual(final["t_stt_final"], final["t_stt_start"])
        self.assertAlmostEqual(end["speech_ms"], 320.0, delta=1)

    def test_gate_closes_after_each_utterance_until_reopened(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        t = speak_utterance(factories)
        stream.wait_for(lambda e: e["event"] == "stt_final")
        # second utterance while the core is still busy: must be ignored
        t = speak_utterance(factories, t0=t)
        time.sleep(0.15)
        self.assertEqual(len(stream.events("speech_end")), 1)
        self.assertEqual(factories.stt.calls, 1)
        # core reopens the gate -> next utterance is heard
        service.handle({"cmd": "set_listening", "enabled": True})
        speak_utterance(factories, t0=now_ms() + 5)
        stream.wait_for(lambda e: e["event"] == "stt_final" and e["utterance_id"] != stream.events("stt_final")[0]["utterance_id"])
        self.assertEqual(len(stream.events("speech_end")), 2)

    def test_audio_captured_before_the_gate_opened_is_dropped(self):
        config = dict(CONFIG, audio=dict(CONFIG["audio"], listenResumeDelayMs=250))
        service, stream, factories = make_service()
        init(service, stream, config)
        service.handle({"cmd": "set_listening", "enabled": True})
        # frames time-stamped inside the resume delay window (e.g. echo tail)
        speak_utterance(factories, t0=now_ms() - 1000)
        time.sleep(0.15)
        self.assertEqual(stream.events("speech_start"), [])
        # frames after the window are processed
        speak_utterance(factories, t0=now_ms() + 300)
        stream.wait_for(lambda e: e["event"] == "stt_final")

    def test_disabling_listening_mid_speech_drops_the_utterance(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        t = now_ms() + 5
        for _ in range(6):
            t += 32
            factories.audio_in.on_frame(LOUD, t)
        stream.wait_for(lambda e: e["event"] == "speech_start")
        service.handle({"cmd": "set_listening", "enabled": False})
        for _ in range(12):
            t += 32
            factories.audio_in.on_frame(QUIET, t)
        time.sleep(0.15)
        self.assertEqual(stream.events("speech_end"), [])

    def test_short_noise_is_discarded_without_closing_the_gate(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        t = speak_utterance(factories, speech_frames=2)
        stream.wait_for(lambda e: e["event"] == "speech_discarded")
        speak_utterance(factories, t0=t)
        stream.wait_for(lambda e: e["event"] == "stt_final")

    def test_stt_failure_reports_discard_and_error_status(self):
        service, stream, factories = make_service(FakeFactories(stt=FakeStt(fail=True)))
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        speak_utterance(factories)
        d = stream.wait_for(lambda e: e["event"] == "stt_discarded")
        self.assertIn("stt_error", d["reason"])
        self.assertTrue([e for e in stream.events("status") if e["component"] == "stt" and e["state"] == "error"])

    def test_hallucinated_transcript_is_discarded(self):
        service, stream, factories = make_service(FakeFactories(stt=FakeStt(text="Продолжение следует...")))
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        speak_utterance(factories)
        d = stream.wait_for(lambda e: e["event"] == "stt_discarded")
        self.assertEqual(d["reason"], "known_hallucination")
        self.assertEqual(stream.events("stt_final"), [])


class MicrophoneDiagnosticsTest(unittest.TestCase):
    """'mic ready' only means the stream opened. These events say what came through it."""

    def feed(self, factories, frame, n, t0=None):
        t = now_ms() + 5 if t0 is None else t0
        for _ in range(n):
            t += 32
            factories.audio_in.on_frame(frame, t)
        return t

    def test_stats_on_request_before_anything_was_heard(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "get_mic_stats", "id": 7})
        st = stream.wait_for(lambda e: e["event"] == "mic_stats" and e.get("reply_to") == 7)
        self.assertEqual(st["listening"], False)
        self.assertEqual(st["frames"], 0)
        self.assertEqual(st["signal"], "no_frames")
        self.assertEqual(st["stream"]["device"], "Fake Mic")
        self.assertEqual(st["mic_open"], True)
        self.assertEqual(st["vad_ready"], True)

    def test_a_device_that_delivers_only_zeros_is_reported_as_no_signal(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        self.feed(factories, np.zeros(512, dtype=np.float32), 170)     # ~5.4 s of digital silence
        st = stream.wait_for(lambda e: e["event"] == "mic_stats" and e["reason"] == "periodic")
        self.assertEqual(st["signal"], "digital_silence")
        self.assertEqual(st["peak"], 0.0)
        self.assertEqual(st["rms"], 0.0)
        self.assertGreaterEqual(st["frames"], 157)
        self.assertEqual(st["max_speech_prob"], 0.0)
        self.assertEqual(st["speech_starts"], 0)
        self.assertEqual(st["listening"], True)
        status = stream.wait_for(lambda e: e["event"] == "status" and e["component"] == "mic" and "no sound so far" in e.get("detail", ""))
        self.assertEqual(status["state"], "ready")           # the stream IS open; the detail says nothing arrives
        self.assertEqual(status["info"]["signal"], "digital_silence")
        self.assertEqual(stream.events("speech_start"), [])
        self.assertEqual(factories.stt.calls, 0)

    def test_sound_without_speech_is_told_apart_from_silence(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        self.feed(factories, np.full(512, 0.03, dtype=np.float32), 170)  # audible, but the VAD says "not speech"
        st = stream.wait_for(lambda e: e["event"] == "mic_stats" and e["reason"] == "periodic")
        self.assertEqual(st["signal"], "ok")
        self.assertAlmostEqual(st["peak"], 0.03, places=4)
        self.assertAlmostEqual(st["rms"], 0.03, places=4)
        self.assertEqual(st["max_speech_prob"], 0.0)
        self.assertEqual(st["frames_over_threshold"], 0)
        self.assertEqual(st["speech_starts"], 0)
        time.sleep(0.05)
        flagged = [e for e in stream.events("status") if e["component"] == "mic" and "signal" in (e.get("info") or {})]
        self.assertEqual(flagged, [], "a working microphone does not produce status noise")

    def test_the_status_recovers_when_the_signal_appears(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        t = self.feed(factories, np.zeros(512, dtype=np.float32), 170)
        stream.wait_for(lambda e: e["event"] == "status" and e["component"] == "mic" and "no sound so far" in e.get("detail", ""))
        service.handle({"cmd": "set_listening", "enabled": False})
        service.handle({"cmd": "set_listening", "enabled": True})
        self.feed(factories, np.full(512, 0.03, dtype=np.float32), 170, t0=now_ms() + 5)
        ok = stream.wait_for(lambda e: e["event"] == "status" and e["component"] == "mic" and (e.get("info") or {}).get("signal") == "ok")
        self.assertEqual(ok["detail"], "Fake Mic")

    def test_an_utterance_is_counted_through_vad_and_stt(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        speak_utterance(factories)
        st = stream.wait_for(lambda e: e["event"] == "mic_stats" and e["reason"] == "speech_end")
        self.assertEqual(st["signal"], "ok")
        self.assertEqual(st["speech_starts"], 1)
        self.assertEqual(st["speech_ends"], 1)
        self.assertEqual(st["frames_over_threshold"], 10)
        self.assertEqual(st["max_speech_prob"], 1.0)
        self.assertEqual(st["stt"]["requests"], 1)
        stream.wait_for(lambda e: e["event"] == "stt_final")
        service.handle({"cmd": "get_mic_stats", "id": 9})
        after = stream.wait_for(lambda e: e["event"] == "mic_stats" and e.get("reply_to") == 9)
        self.assertEqual(after["stt"], {"requests": 1, "final": 1, "discarded": 0, "last_reason": "ok"})
        level = [e for e in stream.events("mic_level") if e["prob"] == 1.0]
        self.assertTrue(level, "the level events carry the speech probability")

    def test_a_sound_shorter_than_min_speech_is_discarded_and_listening_continues(self):
        service, stream, factories = make_service()
        init(service, stream, dict(CONFIG, vad=dict(CONFIG["vad"], minSpeechMs=250, minSilenceMs=600)))
        service.handle({"cmd": "set_listening", "enabled": True})
        t = speak_utterance(factories, speech_frames=1, silence_frames=40)      # 32 ms of "speech", 1.3 s of silence
        discarded = stream.wait_for(lambda e: e["event"] == "speech_discarded")
        self.assertEqual(discarded["speech_ms"], 32.0)
        self.assertEqual(discarded["reason"], "too_short")
        service.handle({"cmd": "get_mic_stats", "id": 11})
        st = stream.wait_for(lambda e: e["event"] == "mic_stats" and e.get("reply_to") == 11)
        self.assertEqual((st["speech_starts"], st["discarded_short"], st["speech_ends"]), (1, 1, 0))
        self.assertEqual(st["in_speech"], False, "no utterance is left open by the rejected sound")
        self.assertEqual(st["listening"], True, "the gate stays open")
        self.assertEqual(service.segmenter.snapshot()["candidate_start_ms"], None)
        self.assertEqual(factories.stt.calls, 0)
        # the next real utterance is heard without reopening anything
        speak_utterance(factories, t0=t, speech_frames=12, silence_frames=30)
        final = stream.wait_for(lambda e: e["event"] == "stt_final")
        self.assertEqual(len(stream.events("speech_end")), 1)
        self.assertAlmostEqual(stream.events("speech_end")[0]["speech_ms"], 384.0, delta=1)
        self.assertEqual(final["text"], "привет как дела")

    def test_a_discarded_transcript_is_counted_with_its_reason(self):
        service, stream, factories = make_service(FakeFactories(stt=FakeStt(text="Продолжение следует...")))
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        speak_utterance(factories)
        stream.wait_for(lambda e: e["event"] == "stt_discarded")
        service.handle({"cmd": "get_mic_stats", "id": 3})
        st = stream.wait_for(lambda e: e["event"] == "mic_stats" and e.get("reply_to") == 3)
        self.assertEqual(st["stt"], {"requests": 1, "final": 0, "discarded": 1, "last_reason": "known_hallucination"})

    def test_closing_the_gate_reports_the_window_and_frames_before_the_gate_are_counted(self):
        config = dict(CONFIG, audio=dict(CONFIG["audio"], listenResumeDelayMs=250))
        service, stream, factories = make_service()
        init(service, stream, config)
        service.handle({"cmd": "set_listening", "enabled": True})
        self.feed(factories, QUIET, 5, t0=now_ms() - 1000)             # stamped before the gate opened
        t = self.feed(factories, QUIET, 8, t0=now_ms() + 300)
        deadline = time.time() + 2
        while time.time() < deadline and service._win["frames"] < 8:
            time.sleep(0.005)
        service.handle({"cmd": "set_listening", "enabled": False})
        st = stream.wait_for(lambda e: e["event"] == "mic_stats" and e["reason"] == "listening_closed")
        self.assertEqual(st["frames_before_gate"], 5)
        self.assertEqual(st["frames"], 8)
        self.assertEqual(st["listening"], False)
        self.assertIsNotNone(t)

    def test_signal_classification(self):
        from services.voice_service.service import classify_signal
        self.assertEqual(classify_signal(0, 0.0), "no_frames")
        self.assertEqual(classify_signal(100, 0.0), "digital_silence")
        self.assertEqual(classify_signal(100, 0.00005), "digital_silence")
        self.assertEqual(classify_signal(100, 0.001), "very_quiet")
        self.assertEqual(classify_signal(100, 0.05), "ok")


class CaptureCountersTest(unittest.TestCase):
    """The capture class counts what the driver delivers, without any device."""

    def test_blocks_from_the_driver_are_counted_with_their_level(self):
        from services.voice_service.audio.capture import AudioInput
        got = []
        mic = AudioInput(lambda frame, t: got.append((frame, t)))
        block = np.zeros((512, 1), dtype=np.float32)
        mic._callback(block, 512, None, None)
        loud = np.full((512, 1), 0.25, dtype=np.float32)
        mic._callback(loud, 512, None, None)
        st = mic.stats()
        self.assertEqual(st["callbacks"], 2)
        self.assertEqual(st["samples"], 1024)
        self.assertEqual(st["frames"], 2)
        self.assertAlmostEqual(st["peak"], 0.25, places=5)
        self.assertAlmostEqual(st["rms"], 0.25 / (2 ** 0.5), places=4)
        self.assertEqual((st["sample_rate"], st["channels"], st["block_samples"]), (16000, 1, 512))
        self.assertEqual(st["stream_active"], False)          # no real stream in this test
        self.assertEqual(len(got), 2)

    def test_only_zeros_from_the_driver(self):
        from services.voice_service.audio.capture import AudioInput
        mic = AudioInput(lambda frame, t: None)
        for _ in range(10):
            mic._callback(np.zeros((512, 1), dtype=np.float32), 512, None, None)
        st = mic.stats()
        self.assertEqual((st["callbacks"], st["peak"], st["rms"]), (10, 0.0, 0.0))


class TtsReturnTest(unittest.TestCase):
    """VC-M3.2: deliver="return" — the chunk comes back as WAV bytes instead of being played here."""

    def test_hello_announces_the_feature(self):
        service, stream, _ = make_service()
        service.hello()
        self.assertIn("tts_return", stream.events("hello")[0]["features"])

    def test_returned_chunk_is_a_valid_wav_and_is_not_played_locally(self):
        import io as _io
        import wave
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "Привет.", "deliver": "return"})
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 1, "text": "Как дела?", "deliver": "return"})
        audio = [stream.wait_for(lambda e: e["event"] == "tts_audio" and e["seq"] == s) for s in (0, 1)]
        for a in audio:
            with wave.open(_io.BytesIO(a["_payload"]), "rb") as w:
                self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()), (1, 2, 48000, 4800))
            self.assertEqual(a["format"], "wav")
            self.assertAlmostEqual(a["audio_ms"], 100.0)
        self.assertEqual([e["seq"] for e in stream.events("tts_synth_done")], [0, 1])
        time.sleep(0.05)
        self.assertEqual(stream.events("tts_playback_start"), [], "nothing played on the local output")
        self.assertEqual(stream.events("tts_drained"), [], "returned chunks are not tracked as local playback")

    def test_stop_drops_a_chunk_still_in_synthesis(self):
        gate = threading.Event()
        tts = FakeTts()
        real = tts.synthesize

        def slow(text, voice=None):
            gate.wait(2)
            return real(text, voice)
        tts.synthesize = slow
        service, stream, _ = make_service(FakeFactories(tts=tts))
        init(service, stream)
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "Привет.", "deliver": "return"})
        time.sleep(0.05)
        service.handle({"cmd": "tts_stop"})
        gate.set()
        time.sleep(0.2)
        self.assertEqual(stream.events("tts_audio"), [], "a stopped answer's audio is never delivered late")

    def test_unspeakable_chunk_returns_nothing(self):
        service, stream, _ = make_service()
        init(service, stream)
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "!!!", "deliver": "return"})
        done = stream.wait_for(lambda e: e["event"] == "tts_synth_done")
        self.assertEqual(done["audio_ms"], 0.0)
        time.sleep(0.05)
        self.assertEqual(stream.events("tts_audio"), [])

    def test_return_works_without_a_local_output_device(self):
        f = FakeFactories()
        service, stream, factories = make_service(f)
        init(service, stream)
        service.audio_out = None   # e.g. the speakers could not be opened
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "Привет.", "deliver": "return"})
        stream.wait_for(lambda e: e["event"] == "tts_audio")

    def test_emitter_writes_header_and_payload_as_one_frame(self):
        from services.voice_service.protocol import Emitter
        from .fakes import CaptureStream
        cs = CaptureStream()
        em = Emitter(cs)
        em.emit("a", x=1)
        em.emit_binary("tts_audio", b"\x00\n\x01!2 {}\n", turn_id="t", seq=0)
        em.emit("b")
        self.assertEqual([e["event"] for e in cs.events()], ["a", "tts_audio", "b"])
        self.assertEqual(cs.events("tts_audio")[0]["_payload"], b"\x00\n\x01!2 {}\n")
        with self.assertRaises(ValueError):
            em.emit_binary("tts_audio", b"")


class TtsPathTest(unittest.TestCase):
    def test_chunks_are_synthesized_played_in_order_then_drained(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "Привет."})
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 1, "text": "Как дела?"})
        service.handle({"cmd": "tts_end_turn", "turn_id": "t1"})
        drained = stream.wait_for(lambda e: e["event"] == "tts_drained")
        self.assertEqual(drained["turn_id"], "t1")
        self.assertEqual(drained["chunks"], 2)
        self.assertFalse(drained["aborted"])
        self.assertEqual([e["seq"] for e in stream.events("tts_synth_done")], [0, 1])
        self.assertEqual([e["seq"] for e in stream.events("tts_playback_start")], [0, 1])
        synth = stream.events("tts_synth_done")[0]
        self.assertGreaterEqual(synth["t_synth_done"], synth["t_synth_start"])
        self.assertGreaterEqual(synth["t_synth_start"], synth["t_accepted"])
        self.assertAlmostEqual(synth["audio_ms"], 100.0)
        start = stream.events("tts_playback_start")[0]
        self.assertTrue(start["approximate"])
        self.assertGreaterEqual(drained["t_playback_end"], start["t_playback_start"])
        names = [e["event"] for e in stream.events() if e["event"].startswith("tts_")]
        self.assertEqual(names[-1], "tts_drained")

    def test_drained_waits_for_playback_to_finish(self):
        service, stream, factories = make_service()
        init(service, stream)
        factories.audio_out.hold = True
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "Привет."})
        service.handle({"cmd": "tts_end_turn", "turn_id": "t1"})
        stream.wait_for(lambda e: e["event"] == "tts_synth_done")
        time.sleep(0.1)
        self.assertEqual(stream.events("tts_drained"), [])
        data, tag = factories.audio_out.held.pop(0)
        factories.audio_out._finish(data, tag)
        stream.wait_for(lambda e: e["event"] == "tts_drained")

    def test_unspeakable_chunk_is_skipped_and_turn_still_drains(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "!!!"})
        service.handle({"cmd": "tts_end_turn", "turn_id": "t1"})
        drained = stream.wait_for(lambda e: e["event"] == "tts_drained")
        self.assertEqual(drained["chunks"], 0)
        self.assertEqual(stream.events("tts_playback_start"), [])

    def test_stop_aborts_queued_audio_and_reports_aborted_drain(self):
        service, stream, factories = make_service()
        init(service, stream)
        factories.audio_out.hold = True
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "Привет."})
        stream.wait_for(lambda e: e["event"] == "tts_synth_done")
        service.handle({"cmd": "tts_stop"})
        drained = stream.wait_for(lambda e: e["event"] == "tts_drained")
        self.assertTrue(drained["aborted"])
        self.assertEqual(factories.audio_out.held, [])
        # a new turn after the stop works normally
        factories.audio_out.hold = False
        service.handle({"cmd": "tts_speak", "turn_id": "t2", "seq": 0, "text": "Снова привет."})
        service.handle({"cmd": "tts_end_turn", "turn_id": "t2"})
        stream.wait_for(lambda e: e["event"] == "tts_drained" and e["turn_id"] == "t2" and not e["aborted"])

    def test_synthesis_failure_is_reported(self):
        service, stream, _ = make_service(FakeFactories(tts=FakeTts(fail=True)))
        init(service, stream)
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "Привет."})
        err = stream.wait_for(lambda e: e["event"] == "tts_error")
        self.assertEqual(err["turn_id"], "t1")
        self.assertIn("synth failed", err["message"])

    def test_voice_change_is_applied_without_reload(self):
        service, stream, factories = make_service()
        init(service, stream)
        cfg = dict(CONFIG, tts=dict(CONFIG["tts"], voice="baya"))
        service.handle({"cmd": "configure", "config": cfg})
        stream.wait_for(lambda e: e["event"] == "status" and e["component"] == "tts" and "baya" in e["detail"])
        self.assertEqual(factories.tts.voice, "baya")

    def test_the_next_synthesis_after_a_voice_change_uses_the_new_voice(self):
        # VC-M1.2: the active character's voice arrives as configuration; no stale speaker may remain
        service, stream, factories = make_service()
        init(service, stream)
        tts = factories.tts
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "Привет."})
        service.handle({"cmd": "tts_end_turn", "turn_id": "t1"})
        stream.wait_for(lambda e: e["event"] == "tts_drained" and e["turn_id"] == "t1")
        service.handle({"cmd": "configure", "config": dict(CONFIG, tts=dict(CONFIG["tts"], voice="baya"))})
        stream.wait_for(lambda e: e["event"] == "status" and e["component"] == "tts" and "baya" in e["detail"])
        service.handle({"cmd": "tts_speak", "turn_id": "t2", "seq": 0, "text": "Снова привет."})
        service.handle({"cmd": "tts_end_turn", "turn_id": "t2"})
        stream.wait_for(lambda e: e["event"] == "tts_drained" and e["turn_id"] == "t2")
        self.assertEqual(tts.spoken, [("Привет.", "xenia"), ("Снова привет.", "baya")])
        self.assertEqual([e["voice"] for e in stream.events("tts_synth_done")], ["xenia", "baya"], "the event names the voice that spoke")
        self.assertIs(factories.tts, tts, "the same engine: the model was not reloaded")

    def test_a_voice_named_in_the_request_applies_to_that_request_only(self):
        # voice preview: one sentence in another voice, the configured voice untouched
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "tts_speak", "turn_id": "preview1", "seq": 0, "text": "Это пример моего голоса.", "voice": "baya"})
        service.handle({"cmd": "tts_end_turn", "turn_id": "preview1"})
        drained = stream.wait_for(lambda e: e["event"] == "tts_drained" and e["turn_id"] == "preview1")
        self.assertEqual((drained["chunks"], drained["aborted"]), (1, False))
        self.assertEqual(stream.events("tts_synth_done")[0]["voice"], "baya")
        self.assertEqual(factories.tts.voice, "xenia", "the configured voice did not change")
        service.handle({"cmd": "tts_speak", "turn_id": "t1", "seq": 0, "text": "Привет."})
        service.handle({"cmd": "tts_end_turn", "turn_id": "t1"})
        stream.wait_for(lambda e: e["event"] == "tts_drained" and e["turn_id"] == "t1")
        self.assertEqual(factories.tts.spoken, [("Это пример моего голоса.", "baya"), ("Привет.", "xenia")])

    def test_an_unknown_voice_in_a_request_is_an_error_not_another_voice(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "tts_speak", "turn_id": "preview1", "seq": 0, "text": "Это пример.", "voice": "natasha"})
        err = stream.wait_for(lambda e: e["event"] == "tts_error")
        self.assertEqual(err["turn_id"], "preview1")
        self.assertIn("natasha", err["message"])
        self.assertEqual(factories.tts.spoken, [], "nothing was spoken in a substitute voice")
        self.assertEqual(stream.events("tts_playback_start"), [])


class LanguageTest(unittest.TestCase):
    def test_language_from_the_core_reaches_stt_and_tts_and_is_reported(self):
        service, stream, factories = make_service()
        init(service, stream)
        self.assertEqual(factories.stt_settings.language, "ru")
        self.assertEqual(factories.tts_settings.language, "ru")
        ready = {e["component"]: e for e in stream.events("status") if e["state"] == "ready"}
        self.assertEqual(ready["stt"]["info"]["language"], "ru")
        self.assertEqual(ready["tts"]["info"]["language"], "ru")
        service.handle({"cmd": "set_listening", "enabled": True})
        speak_utterance(factories)
        final = stream.wait_for(lambda e: e["event"] == "stt_final")
        self.assertEqual(final["language"], "ru")

    def test_changing_the_language_reloads_stt_and_tts(self):
        service, stream, factories = make_service()
        init(service, stream)
        cfg = dict(CONFIG, language="xx", stt=dict(CONFIG["stt"], language="xx"), tts=dict(CONFIG["tts"], language="xx"))
        service.handle({"cmd": "configure", "config": cfg})
        stream.wait_for(lambda e: e["event"] == "status" and e["component"] == "stt" and e["state"] == "ready"
                        and e["info"].get("language") == "xx")
        self.assertEqual(factories.stt_settings.language, "xx")
        self.assertEqual(factories.tts_settings.language, "xx")

    def test_real_silero_provider_rejects_a_language_it_cannot_speak(self):
        from services.voice_service.tts.silero_tts import LANGUAGES, SileroTts
        self.assertIn("ru", LANGUAGES)
        with self.assertRaises(ValueError):
            SileroTts("v5_5_ru", "", "cpu", 1, 48000, "models", "xx")
        tts = SileroTts("v5_5_ru", "", "cpu", 1, 48000, "models", "ru")
        self.assertEqual(tts.describe()["language"], "ru")
        self.assertIn("/tts/ru/v5_5_ru.pt", __import__("services.voice_service.tts.silero_tts", fromlist=["MODEL_URL"]).MODEL_URL.format(language="ru", model_id="v5_5_ru"))

    def test_normalizer_and_filter_are_selected_by_language(self):
        from services.voice_service.stt.transcript_filter import check_transcript
        from services.voice_service.tts.text_normalize import normalizer_for
        normalize, speakable = normalizer_for("ru")
        self.assertTrue(speakable(normalize("Привет")))
        with self.assertRaises(ValueError):
            normalizer_for("xx")
        self.assertFalse(check_transcript("Продолжение следует...", 0.1, -0.3, language="ru")[0])
        self.assertTrue(check_transcript("Продолжение следует...", 0.1, -0.3, language="xx")[0])


class RetranscribeTest(unittest.TestCase):
    def test_recent_utterances_can_be_rerun_through_another_model(self):
        service, stream, factories = make_service()
        init(service, stream)
        service.handle({"cmd": "set_listening", "enabled": True})
        speak_utterance(factories)
        stream.wait_for(lambda e: e["event"] == "stt_final")
        service.handle({"cmd": "stt_retranscribe", "id": 9, "model": "base"})
        r = stream.wait_for(lambda e: e["event"] == "stt_retranscribe_result")
        self.assertEqual(r["reply_to"], 9)
        self.assertEqual(len(r["results"]), 1)
        self.assertEqual(r["results"][0]["reference_text"], "привет как дела")


if __name__ == "__main__":
    unittest.main()
