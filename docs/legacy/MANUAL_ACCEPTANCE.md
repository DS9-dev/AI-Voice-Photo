# VC-M0 manual acceptance (clean start)

Your clean fresh-start run is the authoritative result for everything
subjective: does it hear you, does it sound right, does it feel responsive,
does the application look right.

## Before you start

1. LM Studio is running, its local server is started, Qwen 3.5 9B is loaded.
2. Microphone and speakers/headphones are connected.
3. No VaMVoiceCompanion window is open. (`stop_helpers.bat` clears leftovers;
   it never touches LM Studio.)

## Clean-start commands

Run from `T:\AI\VaMVoiceCompanion` (double-click, or from a terminal):

```
setup.bat          first time only (downloads ~4–5 GB)
run_tests.bat      automated tests           → expect "RESULT: PASS"
tts_smoke.bat      the voice by itself       → expect "RESULT: PASS" and an audible sentence
llm_smoke.bat      the LLM by itself         → expect "RESULT: PASS" and three Russian answers
mic_smoke.bat      the microphone by itself  → expect "RESULT: PASS" and your sentence as text
acceptance.bat     scripted live tests       → writes the reports
start.bat          the application itself
```

## Part 0 — the voice by itself (`tts_smoke.bat`)

Run this before the acceptance script; nothing else needs to be running.

1. It prints a TLS diagnosis of the model download host (which trust store
   verifies it, the certificate chain, any expired certificate).
2. It installs the Silero model if `models/silero/` does not have it yet,
   loads it and synthesizes one Russian sentence.
3. You hear that sentence in a **female Russian voice** on the configured
   output device.

Expected: every line `ok`, `RESULT: PASS`, and the printed model/voice are
`v5_5_ru` / `xenia` (or the voice you selected). The measurements are in
`artifacts/reports/tts_smoke.json`; the audio is `artifacts/tmp/tts_smoke.wav`.

## Part 0b — the LLM by itself (`llm_smoke.bat`)

Needs only LM Studio. It sends a greeting, then a code word to remember,
then asks for that word, all with the application's own system prompt, and
prints for each: the request fields, the HTTP status, the shape of the stream,
`finish_reason`, the thinking control in use, the timings and the answer. It
then asks for the word once more in a fresh context (control).

Expected: `RESULT: PASS`; short Russian answers; `thinking: control "effort";
attempts effort:completed(200)`; delta fields `content` only; the code word in
the third answer and not in the control answer. The last control line
normally says "This model THINKS by default" — that is the model's behaviour
when it is not told otherwise, shown for comparison.

## Part 0c — the microphone by itself (`mic_smoke.bat`)

Close the application first.

1. It lists every input device and marks the one the application uses.
2. It runs the recording from Part 0 through the VAD and Whisper (no
   microphone involved).
3. It asks you to speak one sentence. It prints every state change of the
   segmenter and, once per second, the level, the highest speech probability
   and the state. It records the same device in its native format alongside.
4. It prints what Whisper recognized.

Expected: `RESULT: PASS` and your sentence as text.

If it fails, the conclusion line says which stage: `only_short_sounds` (the
audio had no sustained speech; short sounds were discarded and the segmenter
went back to listening), `speech_not_finished`, `no_speech_detected`,
`digital_silence`, and so on. Two things then tell most:

- Play `artifacts/tmp/mic_smoke.wav`: this is exactly what the application
  captured. Is your sentence audible in it?
- The table "The same device in its own format": if a row shows an utterance
  there while the application's capture had none, the voice is lost in the
  conversion to 16 kHz mono; if no row does, the device's own signal had no
  speech in that run.

The script never changes the selected microphone or any setting.

## Part 1 — scripted live acceptance (`acceptance.bat`)

The script talks you through it:

1. A VaMVoiceCompanion window opens by itself and closes again (GUI self-test). Do not touch it.
2. Read three short answers from the LLM and confirm they are short, coherent Russian.
3. Listen to two spoken test sentences and confirm you heard a **female Russian voice**.
4. Listen to three spoken LLM answers.
5. (Context and Clear Session tests run by themselves.)
6. Speak three sentences for the STT test and confirm the transcripts.
7. Have a five-turn spoken conversation, then stay silent for a few seconds.
8. Answer whether it felt responsive enough.
9. (The language-configuration test evaluates everything above by itself.)

Expected: GUI and tests A–G and L print `PASS`; the summary prints the measured
"speech end → first audible answer" time. The results are in `artifacts/reports/`.

## Part 2 — the application (`start.bat`)

| # | Do | Expect |
|---|---|---|
| 1 | Start the app | Window opens. Bottom strip: MIC, STT, LLM, TTS show a green dot and «готов» within a minute; VaM shows «не настроен». |
| 2 | **Чат**: type `Привет`, press Enter | State goes THINKING → SPEAKING → back to ready. The answer appears and is spoken by a female Russian voice. |
| 3 | Route = *Только TTS*, type a Russian sentence, send | The sentence is spoken as typed; no LLM answer appears. |
| 4 | Route = *Только LLM*, type a question, send | Text answer appears, nothing is spoken. |
| 5 | Микрофон = *Проверка STT*, say a sentence | HEARING SPEECH while you talk; your sentence appears after «Распознано»; no answer. |
| 6 | Микрофон = *Разговор*, say something | LISTENING → HEARING SPEECH → THINKING → SPEAKING → LISTENING. The answer is spoken. |
| 7 | While it is speaking, say something | Nothing happens: it finishes and does not start a second request. It does not react to its own voice. |
| 8 | Say `Меня интересует красный автомобиль.` then `А какого он был цвета?` | The second answer knows the car was red. |
| 9 | Click **Очистить сессию**, then ask `А какого он был цвета?` | The transcript is empty; the answer no longer knows about the car. |
| 10 | **Диагностика** | Per-turn table with the «До звука» column; summary with median/min/max; RAM/VRAM; event log. |
| 11 | **Модели**: change the voice (e.g. `baya`), then send a typed message | The new voice speaks. The setting is still there after restarting the app. |
| 12 | **Настройки → Личность компаньона**: the default text is shown, marked «по умолчанию». Change it (e.g. add `Тебя зовут Мила.`), go to Чат, ask `Как тебя зовут?` | The label changes to «изменена»; the answer uses the new persona, still in Russian and still short. |
| 13 | Restart the app, open the same card; then click **Сбросить по умолчанию** | Your text survived the restart. After the reset the default text is back and marked «по умолчанию». «Правила системы» below it is read-only. |
| 14 | Close the window (red button in the title bar) | The app exits. `doctor.bat` shows no "Voice service PIDs" line. LM Studio is still running. |

## Part 3 — language configuration test

| # | Do | Expect |
|---|---|---|
| 1 | Fresh-start the application | — |
| 2 | **Настройки → Язык разговора** | Shows **Русский**. |
| 3 | Микрофон = *Разговор*, speak Russian | Your speech is transcribed as Russian text. |
| 4 | Listen to the answer | The companion answers naturally in Russian … |
| 5 | | … in the configured female Russian voice. |
| 6 | **Диагностика → Язык** | `Conversation Language ru`, `STT Language ru`, `LLM Language Instruction ru`, `TTS Language / Voice ru / <voice>`, marked «Согласовано». The «Язык» column of the turn shows `ru`. |
| 7 | Close and start the application again | — |
| 8 | **Настройки → Язык разговора** | Still **Русский**. |

## Part 4 — GUI visual review (your judgement)

This is separate from the functional result and is never marked as passed
automatically. The visual reference is your `electron-hls-recorder` app.

Look for:

- a coherent macOS-inspired desktop appearance, consistent with the reference app;
- clean sidebar navigation;
- a readable Chat page;
- an understandable status strip;
- Models and Diagnostics that do not feel excessively dense;
- logically organized Settings;
- both light and dark appearance (theme button in the title bar: Системная / Светлая / Тёмная).

Tell me the verdict (accepted, or what to change) and I will record it in
`artifacts/reports/user_visual_review.json`; until then the completion artifact
says `USER_REVIEW_PENDING`.

## What to report back

- Which numbered steps did not behave as expected.
- Whether the voice sounded female and Russian, and whether it was understandable.
- Whether the pause between your speech and the answer felt conversational.
- Anything red in the status strip (hover it for the reason).
- Your visual review.
