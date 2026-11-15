# VC-M0 Architecture

Scope: the standalone local conversation loop and the measurements needed to
judge it. No VaM, no VaMTools, no commands, no animation.

## 1. Processes

```
┌───────────────────────────── Electron ─────────────────────────────┐
│  Renderer (app/renderer)            UI only, sandboxed, no Node     │
│        ▲  window.vvc.invoke / onEvent  (preload, allow-listed IPC)  │
│        ▼                                                            │
│  Main (app/electron)                window + lifecycle + IPC glue   │
│        │  in-process calls                                          │
│        ▼                                                            │
│  Core (core/)                       plain Node.js, no Electron      │
│    state machine · session history · orchestrator · metrics · config│
│    LLMProvider ──HTTP/SSE──────────────►  LM Studio (external)      │
│    STTProvider ┐                                                    │
│    TTSProvider ┴─ JSON lines over stdin/stdout ─┐                   │
└─────────────────────────────────────────────────┼───────────────────┘
                                                  ▼
                    Voice service (services/voice_service, Python)
                    mic → Silero VAD → faster-whisper
                    text → Silero TTS → speakers
```

- No inference runs in the renderer or in the Electron main process.
- The voice service is a child process started and stopped by the Core.
  It exits by itself when its stdin closes, so it cannot outlive the app.
  Shutdown escalates: `shutdown` command → close stdin → kill process tree,
  and ends with an explicit check that the service process is gone.
- **Process ownership.** On Windows `.venv\Scripts\python.exe` is a venv
  launcher that starts the real interpreter as its child, so two processes
  exist: the one the Core started (`spawnPid`, the launcher) and the one
  running the service code (`servicePid`, reported as `pid` in `hello`). They
  are equal only when the interpreter is started directly. `hello` also carries
  `parent_pid`, `ancestors`, `executable` and `via_launcher`; the client
  classifies the relationship as `direct`, `launcher` or `descendant` and
  refuses to run a service that is not in the tree of the process it started.
  The Core owns both processes: after `stop()`, and after an unexpected exit
  of the started process, it waits for the service process to disappear and
  terminates it by pid (image name checked) if it does not. Nothing relies on
  the launcher cleaning up its child.
- **Three layers keep the service from outliving its owner**, in the order
  they normally act:
  1. the service ends itself when its stdin closes (owner or launcher gone);
  2. on Windows the operating system usually kills it with its launcher,
     because libuv (Node/Electron) and CPython's venv launcher each put their
     child into a kill-on-close job object. This is platform behaviour, not a
     contract of this application: a process started outside those jobs
     survives, and on Linux nothing of the kind exists;
  3. the explicit reap in `VoiceServiceClient._reapService`: the recorded
     service pid is polled; if it stays alive for the whole grace period
     (`reapGraceMs`, 1.5 s) the client terminates exactly that pid, and only
     when its image name is the one reported in `hello`
     (`taskkill /F /T /FI "PID eq …" /FI "IMAGENAME eq …"` on Windows),
     then waits until it is gone. Processes are never selected by name alone.
  Layer 3 is the guarantee; it is tested with a service that ignores shutdown
  and stdin and is started outside the launcher's job, so that layers 1 and 2
  cannot be what removes it.
- LM Studio is external. The app only sends HTTP requests to it.
- A component failure becomes a visible status (`error` + reason) in the status
  strip, the Models tab and Diagnostics; other components keep working.

## 2. Core

| Module | Responsibility |
|---|---|
| `core/index.js` | Composition root (`Companion`). Used by Electron and by the headless acceptance script. |
| `core/state/stateMachine.js` | The three states and the allowed transitions. |
| `core/session/sessionHistory.js` | Last N dialogue turns of the current session, in memory only. |
| `core/conversation/orchestrator.js` | Runs a turn across the providers; gates input; handles failures. |
| `core/conversation/sentenceSplitter.js` | Cuts the streamed answer into sentences for TTS. |
| `core/conversation/thinkFilter.js` | Removes `<think>…</think>` reasoning from speakable text. |
| `core/conversation/prompt.js` | Builds the chat message list. |
| `core/providers/interfaces.js` | Provider contracts. |
| `core/providers/lmStudioProvider.js` | `LLMProvider` for LM Studio's OpenAI-compatible API. |
| `core/providers/voiceServiceClient.js` | Child process + protocol client, clock sync. |
| `core/providers/voiceProviders.js` | `STTProvider` / `TTSProvider` adapters over the voice service. |
| `core/language/languages.js` | Conversation-language packs and the fan-out to STT / LLM / TTS. |
| `core/metrics/turnMetrics.js` | Timestamps, derived intervals, written definitions. |
| `core/config/configStore.js` | Defaults + user overlay, validation, persistence. |

### Provider boundaries

```
LLMProvider   checkConnectivity(), streamChat({model, messages, signal, onContent, onReasoning})
STTProvider   setListening(bool); events: speechStart, speechEnd, final, discarded
TTSProvider   speak({turnId, seq, text}), endTurn(turnId), stop();
              events: synthDone, playbackStart, playbackEnd, drained, failed
```

Replacing LM Studio with another runtime means writing another `LLMProvider`
and passing it to `Companion`; nothing else changes. The same holds for STT and
TTS. `AvatarBackend` and `ActionEngine` are intentionally not created yet (see
`integrations/vam/README.md`).

### State machine

```
LISTENING ──utterance or typed text accepted──► THINKING
THINKING  ──first text chunk sent to TTS──────► SPEAKING
SPEAKING  ──playback complete─────────────────► LISTENING
```

Extra edges exist only for diagnostics and failures: `LISTENING → SPEAKING`
(typed text → TTS), `THINKING → LISTENING` (LLM-only bypass, error, empty
answer, manual Stop), `SPEAKING → LISTENING` on error/Stop.

Input acceptance is enforced in two independent places:

1. **Core:** `submitText` and voice transcripts are rejected unless the state
   is LISTENING. Rejections are counted and logged.
2. **Voice service:** a microphone gate. The Core closes it at the start of
   every turn and reopens it when the state returns to LISTENING. The service
   additionally closes the gate itself after every utterance, and drops any
   audio captured before the gate reopened plus a short resume delay
   (`audio.listenResumeDelayMs`, default 250 ms). This is what prevents the
   companion from transcribing its own TTS output.

`HEARING SPEECH` and `TRANSCRIBING` are UI sub-states of LISTENING.

### Session history

In memory, current session only. Default 10 turns, configurable 0–20, trimmed
on every insert so the context is bounded. A turn is stored when the LLM answer
is complete. Clear Session stops any running turn, empties the history and
starts a new session id. Nothing is restored after a restart.

### Conversation language

There is exactly one language setting for the conversation:
`conversation.language` (default `ru`, shown as **Русский** under Настройки).
`resolveLanguageProfile(config)` in `core/language/languages.js` is the only
place where it is turned into provider settings:

| Stage | Derived from the language pack |
|---|---|
| STT | Whisper recognition language (`stt.language` sent to the voice service) |
| LLM | default persona, mandatory language directive and protected rules of the system prompt |
| TTS | Silero model id, list of voices, default (female) voice |

There is no `stt.language` key, and `tts.modelId` / `tts.voice` /
`persona.prompt` are empty by default, meaning "take it from the language
pack". A custom persona still gets the pack's language directive and rules
after it, and a voice that does not belong to the language is replaced by the
pack default, so the three stages cannot be configured into different
languages.

In the voice service the same language selects the TTS provider's language
table, the text normalizer and the phantom-transcript patterns; a language the
provider cannot speak is reported as a TTS error instead of being guessed.

Every turn records the language of each stage as metadata
(`counters.language`: conversation, STT as reported by Whisper, LLM
instruction, TTS language/voice as loaded, `coherent`). Diagnostics shows it
per turn and as a live "Язык" panel; a mismatch is flagged on the turn and in
the event log. These labels are never added to the LLM messages (tested).

Adding a language later: one entry in `LANGUAGES` plus a normalizer in
`services/voice_service/tts/text_normalize.py` and an entry in the Silero
provider's `LANGUAGES`. Conversation Core does not change. Only Russian is
offered and validated in VC-M0.

The interface language is a different setting (`ui.language`). All visible UI
text lives in `app/renderer/strings.js` (one Russian dictionary, `data-i18n`
attributes in the HTML, `t()` in the renderer), so translating the UI later
does not touch application logic. Core status details and the event log are
diagnostic text and stay in English.

### LLM behaviour

> Since VC-M1.1 the protected layer has a second section, `[КАК ВЕСТИ РАЗГОВОР]`
> (natural conversation behaviour), placed between the persona and the system
> rules. This section describes the VC-M0 state; the current prompt structure
> is in [VC_M1_1_NATURAL_CONVERSATION.md](VC_M1_1_NATURAL_CONVERSATION.md).

The system prompt has two layers, assembled in one place
(`resolveLanguageProfile`) and nowhere else:

```
[ЛИЧНОСТЬ]
<persona: user-editable, config persona.prompt, default from the language pack>

[ПРАВИЛА СИСТЕМЫ]
1. <language directive of the conversation language>
2. … protected rules from the language pack
```

| Layer | Owner | Content |
|---|---|---|
| Persona | the user (Настройки → Личность компаньона) | identity, character, manner of speaking, situational framing |
| System rules | the application (`coreRules` in the language pack) | conversation language; short spoken answers; plain speakable text; no physical action is available now, and one is never claimed as done unless the system reported success; the rules override the persona |

The persona text is stored as ordinary configuration (`persona.prompt`, at
most 4000 characters). An empty value, or a value equal to the default, is
stored as empty and means "default persona", so a later change of the built-in
default reaches users who never edited it. Reset writes the empty value. The
rules layer has no configuration key and no editing UI; the Settings page
shows it read-only. No other module contains persona text: the orchestrator
only receives the finished `systemPrompt`. Each turn records whether the
default or a custom persona was used (`counters.persona`), not the text.

The rule about physical actions is the attachment point for later milestones:
when an action channel exists, the rule text changes in the language pack and
the persona stays untouched.

Answers are never hard-truncated; `maxTokens` is a safety
limit (a cut-off is noted on the turn). Generation settings live in
`config.llm`. If the server rejects optional fields (HTTP 400) the request is
repeated without them and the retry is noted.

#### Thinking control

Measured on the target PC on 2026-10-05 (LM Studio, `qwen/qwen3.5-9b` Q4_K_M,
endpoint `POST /v1/chat/completions`, streaming):

| Request | Result |
|---|---|
| `chat_template_kwargs: {enable_thinking: false}`, `max_tokens` 300 (what the first build sent) | HTTP 200; 299 `reasoning_content` deltas, no `content`; `finish_reason: "length"`; usage: 300 completion tokens, 299 of them reasoning |
| + `reasoning_effort: "none"` | HTTP 200; `content` deltas only; `finish_reason: "stop"`; 0 reasoning tokens; about 0.6 s in total |
| `reasoning: {effort: "none"}`, top-level `enable_thinking: false`, `/no_think` in the user message, `reasoning_effort: "low"` | ignored: reasoning as in the first row |
| assistant turn pre-filled with `<think>\n\n</think>\n\n` | `content` only, 0 reasoning tokens |
| no switch-off, `max_tokens` 2500 | 1324 reasoning tokens, then the answer; 21 s |
| invalid `reasoning_effort` | HTTP 400 naming the parameter and the accepted values `none, minimal, low, medium, high, xhigh` |

So the first build's empty answers were not a parser fault: the server sent
valid chunks that contained only reasoning, and the answer budget ran out
before any answer text. The provider therefore works through a short ladder,
starting with what was measured to work:

1. `effort` — `reasoning_effort: "none"` (plus `chat_template_kwargs`, which
   other servers honour).
2. `plain` — the same without `reasoning_effort`, only after an HTTP 400 that
   rejects that field.
3. `prefill` — empty think block as the start of the assistant turn, when a
   reasoning token arrives although thinking was switched off. The provider
   stops reading at that first token and closes the connection, so the wasted
   attempt costs one time-to-first-token, not a full reasoning pass.
4. `budget` — thinking cannot be switched off (or `disableThinking` is false):
   reasoning is read and dropped, and `max_tokens` is raised by
   `reasoningBudgetTokens` so the answer still fits.

The plan that produced an answer is remembered per endpoint and model for the
session. Latency is always counted from the first attempt.

#### What a response is classified as

Every exchange ends in exactly one of these, recorded on the turn
(`counters.llmOutcome`), written to the event log, and shown instead of a bare
"no answer":

| Outcome | Meaning |
|---|---|
| `ok` | speakable answer text |
| `reasoning_only` | reasoning arrived, no answer text |
| `empty` | well-formed completion, no text in it (other delta fields are named) |
| `parser_failure` | HTTP 200, but no chat-completion chunk in it (content type, event count and key structure are recorded) |
| `request_failed` | server not reachable, or no data within the timeout |
| `api_failure` | HTTP error status, or an error object in the stream |
| `aborted` | stopped by the user |

The diagnostic record holds the URL, the request fields (message roles and
lengths, not their text), HTTP status, content type, event and delta-field
counts, `finish_reason`, usage, and the attempts. It never holds reasoning
text, and for unrecognized payloads only their key structure. A server that
answers with one JSON document instead of a stream is understood as well.

### Sentence-chunked speech

With `tts.sentenceStreaming` on (default), each completed sentence of the
streamed answer is sent to TTS immediately, so speech can begin while the LLM
is still generating. Very short fragments are merged with the next sentence.
This is **not** audio streaming: Silero synthesizes each chunk completely
before it is played.

## 3. Voice service

`python -u -m services.voice_service`, run from the project root.

| Module | Responsibility |
|---|---|
| `service.py` | Command handling, worker threads (VAD, STT, TTS, admin), events. |
| `audio/capture.py` | 16 kHz mono capture in 512-sample frames (sounddevice). |
| `audio/playback.py` | One persistent output stream, queue, start/end timestamps. |
| `audio/devices.py` | Device listing by name; prefers WASAPI with auto-convert. |
| `vad/silero_onnx.py` | Silero VAD ONNX via onnxruntime (no torch needed). |
| `vad/segmenter.py` | Speech start / active / end logic with hysteresis and pre-roll. |
| `stt/faster_whisper_stt.py` | faster-whisper; GPU first, visible CPU fallback. |
| `stt/transcript_filter.py` | Rejects empty and known phantom transcripts. |
| `tts/silero_tts.py` | Silero v5 Russian TTS (standalone `torch.package`). |
| `tts/text_normalize.py` | Digits to words, markup/emoji removal for TTS. |
| `doctor.py`, `prefetch.py` | Environment check and model download. |

### TTS model installation

`tts/model_store.py` is the only code that fetches a model file for TTS. The
model is installed once into `models/silero/<id>.pt` and afterwards only read
from disk, so a conversation never needs the network.

- Downloads use verified TLS only (chain and host name). Trust anchors are
  tried in order: the `certifi` bundle, then the operating-system store. There
  is no unverified code path for a download, and non-HTTPS URLs are refused.
  Reason for the order: Python's default on Windows is the Windows certificate
  store alone, and on the target PC that default failed with "certificate has
  expired" for `models.silero.ai` while the server's own certificate was valid
  and the `certifi`-based downloads of the same process (Hugging Face) worked.
- A download goes to `<file>.part`, must match `Content-Length`, must be a zip
  archive (torch.package), and is then renamed into place.
- The SHA-256 of the installed file is written to `<file>.sha256` and compared
  on every later start; a mismatch is a TTS error, not a silent reload. A
  known-good digest can be pinned in `KNOWN_SHA256`.
- `prefetch --tts-file` installs a manually obtained file under the same checks.
- `tls_diagnostics()` reports, per trust store, whether verification succeeds,
  the certificate chain the server presents (read over a handshake that is used
  for nothing else), matching entries of the Windows ROOT/CA stores with their
  expiry dates, and the clock difference to the server. `tts_smoke` prints it.

`tts_smoke.py` is a stand-alone check of this path with the real model and the
real audio output; it does not go through Core.

### Protocol (version 1)

Commands on stdin, events on stdout, one JSON object per line. stderr carries
human-readable logs (stored in `artifacts/logs/voice_service.log`). Stray
prints from libraries are redirected to stderr so they cannot corrupt the
protocol.

| Command | Purpose |
|---|---|
| `clock_sync` | Reply with the service clock (for offset measurement). |
| `init` / `configure` | Load / reload components from settings. |
| `list_devices`, `get_resources` | Audio devices; RAM and GPU memory. |
| `get_mic_stats` | What the microphone delivered since the gate last opened (reply: `mic_stats`). |
| `set_listening` | Open/close the microphone gate. |
| `tts_speak`, `tts_end_turn`, `tts_stop` | Queue a text chunk; mark end of answer; abort. |
| `stt_retranscribe` | Re-run recent utterances through another Whisper model. |
| `shutdown` | Stop cleanly. |

| Event | Meaning |
|---|---|
| `hello` | Process started: protocol version, `pid` of the service process, `parent_pid`, `ancestors`, `executable` (real image), `via_launcher`. |
| `status` | Component `mic` / `vad` / `stt` / `tts` / `output`: `loading`, `ready`, `error`, `stopped` + reason. |
| `speech_start`, `speech_end`, `speech_discarded` | VAD segmentation. |
| `stt_final`, `stt_discarded` | Transcript or reason for rejection. |
| `tts_synth_done`, `tts_playback_start`, `tts_playback_end`, `tts_drained`, `tts_error` | Synthesis and playback progress. |
| `listening`, `mic_level`, `log`, `error` | Gate state, level meter (RMS, peak, speech probability), diagnostics. |
| `mic_stats` | Listen-window facts: device, host API, sample rate, channels, driver callbacks, frames, frames before the gate, peak, RMS, `signal` (`no_frames` / `digital_silence` / `very_quiet` / `ok`), highest speech probability, frames above the threshold, speech starts/ends, short sounds discarded, STT requests/results. Sent every 5 s while listening, when the gate closes, and on request. |

### Microphone diagnostics

`mic: ready` means the input stream opened. It does not mean the device
carries the user's voice: a virtual, inactive or muted device, or one blocked
by the Windows microphone privacy setting, opens normally and delivers zeros.
Three things make that visible:

- The capture class counts every block the driver delivers (callbacks,
  samples, peak, RMS), whether or not anyone is listening.
- While the gate is open the service keeps the listen-window facts above and
  reports them as `mic_stats`, including whether a speech candidate is open
  right now (`in_speech`). After 5 s of digital silence the `mic` status
  detail becomes "no sound so far (the device delivers digital silence)" and
  the Core records it once as a warning. That is not raised as an error: a
  microphone that is gated or muted at the source (many headsets) delivers
  exact zeros while nobody speaks. A stream that delivers no frames at all is
  an error.
- The acceptance script prints these facts when nothing was recognized, names
  the cause (`no_frames`, `no_signal`, `too_quiet`, `no_speech_detected`,
  `only_short_sounds`, `speech_not_finished`, `stt_discarded`), stops waiting
  for a device that delivered only digital silence for the whole listening
  period, and marks the full-pipeline test as blocked by the microphone.

`mic_smoke.py` is the stand-alone version with the real device, VAD and
Whisper; it does not go through Core. It also records the device's native
signal alongside (`NativeRecorder`: default sample rate, all channels) and
analyses each channel, their mean and their difference, which separates a
loss in the 16 kHz mono conversion from a device signal without speech.

### Segmenter state and its trace

The segmenter has two states. *Listening*: no candidate, nothing kept except
the pre-roll audio. *Candidate open*: start time, end of the last frame still
counted as speech, buffered audio. A candidate opens at the first frame at or
above the threshold and is decided when the probability has stayed below the
lower threshold for `minSilenceMs`: it becomes an utterance (`speech_end`) if
its speech lasted at least `minSpeechMs`, otherwise it is discarded
(`speech_discarded`). Both outcomes return to the clean listening state;
nothing of a discarded candidate survives. Durations are whole frames:
512 samples at 16 kHz = 32 ms, so a candidate of one frame is 32 ms long.

`Segmenter.snapshot()` returns that state (`in_speech`, `candidate_start_ms`,
`candidate_ms`, `silence_ms`, `frames_buffered`), and an optional `trace`
callback receives, per frame, the probability, the snapshot before and after,
and the events. `mic_smoke` stores the transitions in its report. The trace
is off in the application.

Target-PC run of 2026-10-06, replayed frame by frame from its recording with
the real VAD: frame 52 (ends 1.696 s) had probability 0.68 and opened a
candidate (start 1.664 s, 32 ms); frames 53–70 stayed below 0.35; at frame 71
(2.304 s, 608 ms of silence) it was discarded as 32 ms long and the state was
clean; none of the 396 frames after it was in speech. The first version of
`mic_smoke` nevertheless concluded "speech_not_finished" because it derived
that from "a candidate was opened and no utterance completed" without looking
at whether a candidate was still open. The segmenter was not at fault and was
not changed; the conclusion logic was.

### End-of-speech detection

Silero VAD classifies 32 ms frames. Speech starts at the first frame above
`vad.threshold`; it ends when the probability has stayed below
`threshold − 0.15` for `vad.minSilenceMs` (default 600 ms). Segments shorter
than `vad.minSpeechMs` are discarded. `minSilenceMs` is the direct trade-off
between cutting people off at natural pauses and added latency; it is exposed
on the Models tab and reported per turn as "VAD end-of-speech delay".

## 4. Timing and metrics

Both processes use wall-clock milliseconds advanced by a monotonic counter.
At service start the Core measures the offset between the two clocks (five
round trips, best one wins) and removes it from every service timestamp.

Timestamps and derived intervals are defined in
`core/metrics/turnMetrics.js` (`METRIC_DEFINITIONS`); the same text is shown in
Diagnostics and in the latency report. The headline metric is

```
perceived latency = tPlaybackStart − tSpeechEnd
                    (user stops speaking → first audible companion audio)
```

It includes the VAD silence wait, STT, LLM time to the first sentence, TTS
synthesis of that sentence and audio output latency. Bypass turns are labeled
by pipeline (`full`, `text_llm_tts`, `llm_only`, `tts_only`, `stt_only`) and
are never mixed into the full-pipeline summary. Failed and slow turns stay in
the tables.

Approximations, stated wherever the numbers are shown:

- playback start/end = audio-callback time + driver-reported output latency;
- speech end = VAD estimate, one-frame resolution, shifted by reported input latency;
- tokens/sec uses the server usage block, or streamed-chunk counts (marked `~`).

## 5. Electron shell and UI

`app/electron/main.js` creates the window, wires IPC and guarantees shutdown of
the Core (and therefore the voice service) on quit. `preload.js` exposes three
functions (`invoke`, `onEvent`, `windowControl`) with an allow-list of
channels; the renderer runs sandboxed with context isolation and a strict
content security policy, and loads only local files. `appController.js` holds
the handlers and has no Electron imports, so it is exercised by tests.
`electron . --self-test` (`selfTest.js`) starts the real app, checks that the
window renders and mirrors the component states, and writes
`artifacts/reports/gui_selftest.json`.

Layout: custom title bar · persistent sidebar (Чат, Команды, VaM, Модели,
Диагностика, Настройки) · active page · status strip at the bottom (MIC, STT,
LLM, TTS, VaM and the conversation state), visible on every page.

- **Models** holds provider/model-specific settings; **Settings** holds
  application-level preferences (conversation language, session history,
  end-of-speech pause, audio devices). No setting appears on both.
- Settings apply on change (no Apply button) and are written to
  `config/user.json`.
- Commands and VaM are shells that state they are inactive.

### Reference UI patterns adopted

The visual direction follows the local reference application
`electron-hls-recorder` (read-only reference; nothing is imported from it and
it is not a dependency). Adopted from it:

| Pattern in the reference | Use in VaMVoiceCompanion |
|---|---|
| Frameless window with a 52 px draggable title bar, traffic-light window buttons on the left (glyphs on hover), centered muted app title, theme button on the right | Same title bar; window buttons go through a `window:control` IPC message |
| Colour tokens `--bg / --surface / --line / --text / --muted / --button / --accent` with a dark set (`#111318`, lavender accent `#b6a0ff`) and a `body.light` set (`#f5f5f8`, `#7055cd`) | Same tokens and values; restrained status colours added for the dots only |
| Segoe UI, 12–13 px controls, tabular numerals for figures | Same |
| Page heading: small uppercase accent "eyebrow", 25 px tight heading, count pill, muted note on the right | Every page heading; the pill shows the conversation state on Chat |
| Surface cards with 1 px border and 14 px radius; 8 px radius buttons; accent-filled primary button; brightness hover; 2 px accent focus ring | Cards for transcript, composer, settings groups, diagnostics; "Отправить" is the primary button |
| Dashed-border, centered, muted empty state | Empty transcript; Commands and VaM placeholder pages |
| Collapsible monospace event log (Consolas, 11 px, 10 px radius) with a "copy logs" button | Diagnostics → Журнал событий |
| Russian interface text | Russian-first UI via `strings.js` |
| Dark/Light toggle stored on the client | Extended to System / Light / Dark, stored in `ui.theme` |

Adapted rather than copied: the reference is a single-page card grid, so the
sidebar, the bottom status strip and the grouped settings rows (label left,
control right, hairline separators) were designed in the same token set for
this application's information architecture. Recorder-specific concepts
(stream cards, previews, recording actions) were not carried over. The
renderer keeps `contextIsolation` and a sandbox, unlike the reference.

Visual acceptance is the user's subjective review (see
`docs/MANUAL_ACCEPTANCE.md`, Part 4); nothing in the project marks it as passed
automatically.

## 6. Configuration and persistence

`config/default.json` (tracked) overlaid by `config/user.json` (git-ignored,
only changed keys). Values are validated and clamped. Conversation history,
audio and transcripts are never persisted. No secrets exist in the project.

## 7. Tests

| Layer | What is verified | How |
|---|---|---|
| Core units | state machine, bounded history, Clear Session, prompt building, sentence splitter, reasoning filter, SSE parsing, metrics maths, config, language fan-out, persona layers | `node --test` |
| LLM provider | request construction, streaming, TTFT, usage, reasoning, thinking-control ladder, response classification, 400 fallback, errors, timeout, abort | fake LM Studio HTTP server, including a mode that replays the behaviour measured on the target PC |
| Orchestrator | turn flow, input rejection while THINKING/SPEAKING, bypasses, failures, watchdog | stub providers |
| Service client + Companion | process lifecycle, clock sync, crash handling, no orphan process, config push | fake voice-service process |
| Process ownership | direct vs launcher start, launcher killed, stuck service, unrelated process rejected, both pids gone | fake launcher + fake service; and the real service process started without `init` |
| Acceptance procedure | the A–G script itself, the status rules, and replays of a reasoning-only LLM and a silent microphone | fakes; report is marked `evidence: "fake"` and can never become a PASS |
| Voice service | segmenter timing, gate behaviour, TTS queue/drain/abort, protocol, text normalization, transcript filter, model store (verified-TLS policy, integrity checks, manual install), TTS smoke logic, microphone diagnostics (listen-window facts, silent device), microphone smoke logic, WAV helpers | Python `unittest` with fake engines |
| Real model check | Silero VAD ONNX on silence/noise; on real speech, directly and through the microphone smoke path | runs when the package is installed; the speech tests need a recording (`artifacts/tmp/tts_smoke.wav` from `tts_smoke.bat`, or `VVC_TEST_SPEECH_WAV`) |
| UI (optional) | real renderer in Chromium against the real Core + fakes | `tests/ui/ui_smoke.js` (Playwright) |

Fakes prove logic only. Capability claims come from `acceptance.bat` on the
real hardware.

## 8. Known limitations

See `knownLimitations` in `artifacts/reports/VC_M0_COMPLETION.json` (single
source, generated by `scripts/make_reports.js`). The ones that shape the
architecture:

- No incremental TTS audio streaming (sentence-chunked instead).
- No barge-in, no echo cancellation; the microphone is gated instead.
- Qwen 3.5 thinks by default ([model card](https://huggingface.co/Qwen/Qwen3.5-9B)),
  and LM Studio ignores `enable_thinking` for it
  ([LM Studio bug tracker #1990](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1990)).
  The app switches it off with `reasoning_effort: "none"`, which worked on the
  target PC; whether that holds for other LM Studio versions is not known, hence
  the fallbacks under *Thinking control*.
- Audio timestamps depend on driver-reported latencies.

## 9. What later milestones can attach to

- **Commands (VC-M2):** the accepted user text is available in
  `ConversationOrchestrator._startTurn` before the LLM call, and the LLM answer
  passes through one place before TTS. A bounded action schema can be added at
  either point without touching providers.
- **VaM (VC-M3+):** an `AvatarBackend` can subscribe to the same TTS events the
  UI uses (`synthDone`, `playbackStart`, `drained`) or become an alternative
  audio sink inside the voice service.
- **Other runtimes:** new provider classes behind the existing interfaces.
