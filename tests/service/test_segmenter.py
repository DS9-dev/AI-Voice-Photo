import unittest

import numpy as np

from services.voice_service.vad.segmenter import Segmenter, SegmenterParams

FRAME_MS = 32.0


def run(seg, probs, t0=1000.0):
    """Feed probabilities; frame i ends at t0 + (i+1)*32 ms. Returns all events."""
    events = []
    for i, p in enumerate(probs):
        frame = np.full(512, float(i), dtype=np.float32)
        events.extend(seg.process(p, frame, t0 + (i + 1) * FRAME_MS))
    return events


class SegmenterTest(unittest.TestCase):
    def make(self, **kw):
        params = SegmenterParams(threshold=0.5, min_speech_ms=250, min_silence_ms=600, speech_pad_ms=96,
                                 max_utterance_ms=30000)
        for k, v in kw.items():
            setattr(params, k, v)
        return Segmenter(params)

    def test_start_and_end_timestamps(self):
        seg = self.make()
        probs = [0.0] * 5 + [0.9] * 20 + [0.0] * 30
        events = run(seg, probs)
        self.assertEqual([e["type"] for e in events], ["speech_start", "speech_end"])
        start, end = events
        # first speech frame is index 5: starts at t0 + 5*32
        self.assertAlmostEqual(start["t_speech_start"], 1000.0 + 5 * FRAME_MS)
        # last speech frame is index 24: ends at t0 + 25*32
        self.assertAlmostEqual(end["t_speech_end"], 1000.0 + 25 * FRAME_MS)
        self.assertAlmostEqual(end["speech_ms"], 20 * FRAME_MS)
        delay = end["t_vad_end_detected"] - end["t_speech_end"]
        self.assertGreaterEqual(delay, 600)
        self.assertLess(delay, 600 + FRAME_MS)
        self.assertFalse(end["forced"])

    def test_short_blip_is_discarded(self):
        seg = self.make()
        events = run(seg, [0.0] * 3 + [0.9] * 3 + [0.0] * 30)
        self.assertEqual([e["type"] for e in events], ["speech_start", "speech_discarded"])
        self.assertEqual(events[1]["reason"], "too_short")
        self.assertFalse(seg.in_speech)

    def test_pause_shorter_than_min_silence_does_not_split(self):
        seg = self.make()
        pause = [0.0] * 12   # 384 ms < 600 ms
        events = run(seg, [0.9] * 15 + pause + [0.9] * 15 + [0.0] * 30)
        self.assertEqual([e["type"] for e in events], ["speech_start", "speech_end"])
        self.assertAlmostEqual(events[1]["speech_ms"], (15 + 12 + 15) * FRAME_MS)

    def test_hysteresis_band_keeps_speech_alive(self):
        seg = self.make()
        # 0.4 is below threshold (0.5) but above neg threshold (0.35)
        events = run(seg, [0.9] * 10 + [0.4] * 40 + [0.0] * 30)
        end = [e for e in events if e["type"] == "speech_end"][0]
        self.assertAlmostEqual(end["speech_ms"], 50 * FRAME_MS)

    def test_max_utterance_forces_end(self):
        seg = self.make(max_utterance_ms=1000)
        events = run(seg, [0.9] * 60)
        ends = [e for e in events if e["type"] == "speech_end"]
        self.assertGreaterEqual(len(ends), 1)
        self.assertTrue(ends[0]["forced"])
        self.assertGreaterEqual(ends[0]["speech_ms"], 1000)

    def test_pre_roll_and_trailing_padding_in_audio(self):
        seg = self.make()  # pad 96 ms = 3 frames
        probs = [0.0] * 10 + [0.9] * 20 + [0.0] * 30
        events = run(seg, probs)
        audio = events[-1]["audio"]
        frames = audio.reshape(-1, 512)[:, 0]
        # 3 pre-roll frames (7, 8, 9), 20 speech frames (10..29), 3 trailing (30, 31, 32)
        self.assertEqual(list(frames), [float(i) for i in range(7, 33)])
        self.assertEqual(audio.dtype, np.float32)

    def test_reset_drops_utterance_in_progress(self):
        seg = self.make()
        run(seg, [0.9] * 10)
        self.assertTrue(seg.in_speech)
        seg.reset()
        self.assertFalse(seg.in_speech)
        events = run(seg, [0.0] * 40)
        self.assertEqual(events, [])

    def test_utterance_ids_increase(self):
        seg = self.make()
        events = run(seg, ([0.9] * 20 + [0.0] * 30) * 2)
        ids = [e["utterance_id"] for e in events if e["type"] == "speech_end"]
        self.assertEqual(ids, [1, 2])


CLEAN = {"in_speech": False, "utterance_id": None, "candidate_start_ms": None, "candidate_ms": 0.0,
         "silence_ms": 0.0, "frames_buffered": 0}


def run_traced(seg, probs, t0=0.0):
    """Like run(), with the per-frame trace. Returns (events, trace rows)."""
    rows = []
    seg.trace = rows.append
    events = run(seg, probs, t0)
    seg.trace = None
    return events, rows


def without(snapshot, *keys):
    return {k: v for k, v in snapshot.items() if k not in keys}


class RejectedCandidateTest(unittest.TestCase):
    """A sound that reaches the threshold but is shorter than min_speech_ms.

    Invariant: once it is rejected the segmenter is in the clean listening
    state. Nothing of the candidate survives: not the "in speech" flag, not
    its start time, not the silence timer, not its audio.
    """

    def make(self, **kw):
        params = SegmenterParams(threshold=0.5, min_speech_ms=250, min_silence_ms=600, speech_pad_ms=200,
                                 max_utterance_ms=30000)
        for k, v in kw.items():
            setattr(params, k, v)
        return Segmenter(params)

    def test_timebase_512_samples_at_16_khz_is_32_ms(self):
        seg = self.make()
        self.assertEqual(seg.frame_ms, 32.0)
        self.assertEqual(Segmenter(seg.params, sample_rate=16000, frame_samples=512).frame_ms, 512 * 1000.0 / 16000)
        # a candidate of N frames above the threshold lasts exactly N * 32 ms
        for n in (1, 2, 5, 7):
            events = run(self.make(), [0.0] * 10 + [0.9] * n + [0.0] * 40, t0=0.0)
            self.assertEqual(events[-1]["type"], "speech_discarded")
            self.assertEqual(events[-1]["speech_ms"], n * 32.0, f"{n} frame(s)")
        for n in (8, 9, 20):
            events = run(self.make(), [0.0] * 10 + [0.9] * n + [0.0] * 40, t0=0.0)
            self.assertEqual(events[-1]["type"], "speech_end")
            self.assertEqual(events[-1]["speech_ms"], n * 32.0, f"{n} frame(s)")

    def test_one_frame_above_threshold_then_long_silence(self):
        seg = self.make()
        events, rows = run_traced(seg, [0.0] * 52 + [0.9] + [0.0] * 415)        # 468 frames = 15 s, like the target-PC run
        self.assertEqual([e["type"] for e in events], ["speech_start", "speech_discarded"])
        self.assertEqual(events[1]["speech_ms"], 32.0)
        self.assertEqual(events[1]["reason"], "too_short")
        self.assertEqual(events[0]["t_speech_start"], 52 * 32.0)
        # decided after 600 ms of silence, i.e. at the first frame end >= start + 32 + 600
        decided = next(r for r in rows if r["events"] and r["events"][0]["type"] == "speech_discarded")
        self.assertEqual(decided["t_ms"], 2304.0)
        self.assertEqual(without(decided["before"], "pre_roll_frames"),
                         {"in_speech": True, "utterance_id": 1, "candidate_start_ms": 1664.0, "candidate_ms": 32.0,
                          "silence_ms": 608.0, "frames_buffered": 26})
        self.assertEqual(without(decided["after"], "pre_roll_frames"), CLEAN)
        # ... and it stays clean for the remaining 12.7 s
        later = rows[rows.index(decided) + 1:]
        self.assertEqual(len(later), 396)
        self.assertTrue(all(not r["after"]["in_speech"] and not r["events"] for r in later))
        self.assertFalse(seg.in_speech)
        self.assertEqual(without(seg.snapshot(), "pre_roll_frames"), CLEAN)

    def test_a_few_frames_shorter_than_min_speech_then_long_silence(self):
        seg = self.make()
        events, rows = run_traced(seg, [0.0] * 20 + [0.9] * 7 + [0.0] * 300)    # 224 ms < 250 ms
        self.assertEqual([e["type"] for e in events], ["speech_start", "speech_discarded"])
        self.assertEqual(events[1]["speech_ms"], 224.0)
        self.assertEqual(sum(1 for r in rows if r["after"]["in_speech"]), 7 + 18, "open only from the first frame until the silence timeout")
        self.assertEqual(without(seg.snapshot(), "pre_roll_frames"), CLEAN)

    def test_target_pc_trace_of_2026_10_06(self):
        """The speech probabilities the real Silero VAD produced for the target-PC recording."""
        measured = [0.681, 0.308, 0.242, 0.171, 0.147, 0.082, 0.072, 0.049, 0.044, 0.042, 0.028, 0.015, 0.011, 0.008,
                    0.007, 0.009, 0.008, 0.005, 0.003, 0.004, 0.004, 0.007, 0.007, 0.006]          # frames 52..75
        lead = [0.05] * 50 + [0.043, 0.148]                                                      # frames 0..51
        probs = lead + measured + [0.001] * (468 - len(lead) - len(measured))
        seg = self.make()
        events, rows = run_traced(seg, probs)
        self.assertEqual([(e["type"], e.get("speech_ms")) for e in events], [("speech_start", None), ("speech_discarded", 32.0)])
        opened = rows[52]
        self.assertEqual(opened["events"][0]["type"], "speech_start")
        self.assertEqual((opened["t_ms"], opened["after"]["candidate_start_ms"], opened["after"]["candidate_ms"]), (1696.0, 1664.0, 32.0))
        # 0.308 at frame 53 is below the lower hysteresis threshold (0.35): it does not extend the candidate
        self.assertEqual(rows[53]["after"]["candidate_ms"], 32.0)
        self.assertEqual(rows[53]["after"]["silence_ms"], 32.0)
        self.assertEqual(rows[70]["after"]["in_speech"], True)
        self.assertEqual(rows[70]["after"]["silence_ms"], 576.0)
        self.assertEqual(rows[71]["events"][0]["type"], "speech_discarded")
        self.assertEqual(rows[71]["t_ms"], 2304.0)
        self.assertEqual(without(rows[71]["after"], "pre_roll_frames"), CLEAN)
        self.assertEqual(sum(1 for r in rows[72:] if r["after"]["in_speech"]), 0)
        self.assertFalse(seg.in_speech, "not in speech at the end: this run is 'only a short sound', not 'speech not finished'")

    def test_valid_speech_then_silence_is_exactly_one_utterance(self):
        seg = self.make()
        events, rows = run_traced(seg, [0.0] * 30 + [0.9] * 40 + [0.0] * 200)
        self.assertEqual([e["type"] for e in events], ["speech_start", "speech_end"])
        end = events[1]
        self.assertEqual(end["speech_ms"], 40 * 32.0)
        self.assertEqual(end["t_speech_start"], 30 * 32.0)
        self.assertEqual(end["t_speech_end"], 70 * 32.0)
        self.assertEqual(end["t_vad_end_detected"], 70 * 32.0 + 608.0)
        self.assertFalse(end["forced"])
        self.assertEqual(without(seg.snapshot(), "pre_roll_frames"), CLEAN)
        self.assertEqual(sum(len(r["events"]) for r in rows), 2, "nothing else happens in the 5.8 s of silence that follow")

    def test_a_valid_utterance_after_a_rejected_sound_is_detected_normally(self):
        seg = self.make()
        events = run(seg, [0.0] * 10 + [0.9] + [0.0] * 60 + [0.9] * 20 + [0.0] * 40, t0=0.0)
        self.assertEqual([e["type"] for e in events], ["speech_start", "speech_discarded", "speech_start", "speech_end"])
        self.assertEqual([e["utterance_id"] for e in events], [1, 1, 2, 2])
        self.assertEqual(events[3]["speech_ms"], 640.0)
        # the rejected sound's audio is not part of the utterance: pre-roll (7 frames) + 20 speech + trailing pad
        self.assertEqual(len(events[3]["audio"]) // 512, 7 + 20 + 6)

    def test_several_rejected_sounds_in_a_row_never_accumulate(self):
        seg = self.make()
        probs = []
        for _ in range(5):
            probs += [0.9, 0.9] + [0.0] * 30
        events, rows = run_traced(seg, probs + [0.0] * 100)
        self.assertEqual([e["type"] for e in events], ["speech_start", "speech_discarded"] * 5)
        self.assertTrue(all(e["speech_ms"] == 64.0 for e in events if e["type"] == "speech_discarded"))
        self.assertEqual(without(seg.snapshot(), "pre_roll_frames"), CLEAN)

    def test_tracing_does_not_change_behaviour(self):
        probs = [0.0] * 5 + [0.9] + [0.0] * 30 + [0.6, 0.4, 0.4, 0.9] * 6 + [0.0] * 40
        plain = run(self.make(), probs, t0=0.0)
        traced, rows = run_traced(self.make(), probs)
        strip = lambda evs: [{k: v for k, v in e.items() if k != "audio"} for e in evs]
        self.assertEqual(strip(plain), strip(traced))
        self.assertEqual(len(rows), len(probs))
        self.assertIsNone(self.make().trace, "no trace unless asked for")

    def test_snapshot_of_an_open_candidate(self):
        seg = self.make()
        run(seg, [0.0] * 3 + [0.9] * 4 + [0.0] * 5, t0=0.0)
        self.assertEqual(without(seg.snapshot(12 * 32.0), "pre_roll_frames"),
                         {"in_speech": True, "utterance_id": 1, "candidate_start_ms": 96.0, "candidate_ms": 128.0,
                          "silence_ms": 160.0, "frames_buffered": 3 + 4 + 5})


if __name__ == "__main__":
    unittest.main()
