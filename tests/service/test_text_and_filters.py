import unittest

import numpy as np

from services.voice_service.audio.capture import FrameAssembler
from services.voice_service.audio.playback import PlaybackQueue
from services.voice_service.settings import Settings
from services.voice_service.stt.transcript_filter import check_transcript
from services.voice_service.tts.text_normalize import (has_speakable, normalize_for_tts,
                                                       number_to_words, split_long)


class NumberWordsTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(number_to_words(0), "ноль")
        self.assertEqual(number_to_words(7), "семь")
        self.assertEqual(number_to_words(15), "пятнадцать")
        self.assertEqual(number_to_words(21), "двадцать один")
        self.assertEqual(number_to_words(100), "сто")
        self.assertEqual(number_to_words(342), "триста сорок два")

    def test_thousands_are_feminine_and_declined(self):
        self.assertEqual(number_to_words(1000), "одна тысяча")
        self.assertEqual(number_to_words(2000), "две тысячи")
        self.assertEqual(number_to_words(5000), "пять тысяч")
        self.assertEqual(number_to_words(21000), "двадцать одна тысяча")
        self.assertEqual(number_to_words(2026), "две тысячи двадцать шесть")
        self.assertEqual(number_to_words(1000000), "один миллион")
        self.assertEqual(number_to_words(-3), "минус три")


class NormalizeTest(unittest.TestCase):
    def test_digits_markup_and_emoji(self):
        out = normalize_for_tts("**Привет!** Сейчас 15 градусов 😀")
        self.assertEqual(out, "Привет! Сейчас пятнадцать градусов")

    def test_latin_is_transliterated_not_dropped(self):
        out = normalize_for_tts("Это RTX")
        self.assertTrue(out.startswith("Это "))
        self.assertRegex(out, r"^[а-яёА-ЯЁ ]+$")

    def test_only_symbols_is_not_speakable(self):
        self.assertFalse(has_speakable(normalize_for_tts("😀 ... !!!")))
        self.assertTrue(has_speakable(normalize_for_tts("Да.")))

    def test_stress_marks_from_llm_are_not_passed_through(self):
        self.assertNotIn("+", normalize_for_tts("прив+ет"))

    def test_split_long(self):
        text = ", ".join(["слово"] * 300)
        parts = split_long(text, max_chars=200)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all(len(p) <= 200 for p in parts))
        self.assertEqual(split_long("коротко"), ["коротко"])


class TranscriptFilterTest(unittest.TestCase):
    def test_accepts_normal_speech(self):
        self.assertEqual(check_transcript("Привет, как дела?", 0.02, -0.3), (True, "ok"))

    def test_rejects_empty(self):
        self.assertFalse(check_transcript("", None, None)[0])
        self.assertFalse(check_transcript(" ... ", None, None)[0])

    def test_rejects_known_hallucinations(self):
        for text in ["Субтитры сделал DimaTorzok", "Продолжение следует...", "Редактор субтитров А.Синецкая"]:
            ok, reason = check_transcript(text, 0.1, -0.4)
            self.assertFalse(ok, text)
            self.assertEqual(reason, "known_hallucination")

    def test_legitimate_mention_of_subtitles_is_kept(self):
        self.assertTrue(check_transcript("Включи субтитры, пожалуйста", 0.02, -0.3)[0])

    def test_rejects_low_confidence_no_speech(self):
        self.assertEqual(check_transcript("угу", 0.9, -1.5), (False, "low_confidence_no_speech"))


class FrameAssemblerTest(unittest.TestCase):
    def test_rechunks_and_timestamps(self):
        fa = FrameAssembler(512)
        # 768 samples ending at t=1000 ms -> one frame ending 256 samples (16 ms) earlier
        out = fa.push(np.arange(768, dtype=np.float32), 1000.0)
        self.assertEqual(len(out), 1)
        frame, t_end = out[0]
        self.assertEqual(frame[0], 0.0)
        self.assertAlmostEqual(t_end, 1000.0 - 16.0)
        out = fa.push(np.arange(768, 1024, dtype=np.float32), 1016.0)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0][0][0], 512.0)
        self.assertAlmostEqual(out[0][1], 1016.0)


class PlaybackQueueTest(unittest.TestCase):
    def test_fill_and_notifications(self):
        q = PlaybackQueue(48000)
        q.enqueue(np.ones(480, dtype=np.float32), "a")        # 10 ms
        q.enqueue(np.full(480, 2.0, dtype=np.float32), "b")
        notes = []
        buf = np.zeros(720, dtype=np.float32)                  # 15 ms buffer
        n = q.fill(buf, 5000.0, lambda kind, tag, t: notes.append((kind, tag, round(t, 3))))
        self.assertEqual(n, 720)
        self.assertEqual(notes, [("start", "a", 5000.0), ("end", "a", 5010.0), ("start", "b", 5010.0)])
        self.assertEqual(buf[479], 1.0)
        self.assertEqual(buf[480], 2.0)
        buf2 = np.ones(720, dtype=np.float32)
        n2 = q.fill(buf2, 5015.0, lambda kind, tag, t: notes.append((kind, tag, round(t, 3))))
        self.assertEqual(n2, 240)
        self.assertEqual(notes[-1], ("end", "b", 5020.0))
        self.assertTrue(np.all(buf2[240:] == 0.0))            # silence after the queue empties

    def test_clear_returns_dropped_tags(self):
        q = PlaybackQueue(48000)
        q.enqueue(np.ones(10, dtype=np.float32), "x")
        self.assertEqual(q.clear(), ["x"])
        self.assertEqual(q.pending(), 0)


class SettingsTest(unittest.TestCase):
    def test_from_core_config(self):
        s = Settings.from_dict({
            "stt": {"model": "base", "device": "cpu", "computeType": "int8", "language": "ru", "beamSize": 1},
            "tts": {"modelId": "v5_5_ru", "voice": "baya", "device": "cpu", "threads": 2, "sampleRate": 48000, "language": "ru"},
            "vad": {"threshold": 0.6, "minSpeechMs": 200, "minSilenceMs": 500, "speechPadMs": 100, "maxUtteranceSec": 10},
            "audio": {"hostApi": "wasapi", "inputDevice": "Mic", "outputDevice": "", "listenResumeDelayMs": 300},
            "paths": {"models_dir": "X:/models"},
        })
        self.assertEqual(s.stt.model, "base")
        self.assertEqual(s.stt.compute_type, "int8")
        self.assertEqual(s.tts.voice, "baya")
        self.assertEqual(s.tts.language, "ru")
        self.assertEqual(s.stt.language, "ru")
        self.assertEqual(s.vad.max_utterance_ms, 10000.0)
        self.assertEqual(s.audio.input_device, "Mic")
        self.assertEqual(s.models_dir, "X:/models")

    def test_defaults_on_garbage(self):
        s = Settings.from_dict({"vad": {"threshold": "abc"}, "stt": None})
        self.assertEqual(s.vad.threshold, 0.5)
        self.assertEqual(s.stt.model, "small")


if __name__ == "__main__":
    unittest.main()
