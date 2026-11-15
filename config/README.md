# Configuration

- `default.json` — tracked defaults. Do not put machine-specific values here.
- `user.json` — created by the app when you change settings; git-ignored.
  Contains only the keys you changed (devices, endpoint, character profiles, tuning).

Conversation history is never stored. No API keys or tokens are needed or kept.

| Section | Keys worth knowing |
|---|---|
| `conversation` | `language` (conversation language, default `ru`; the single source for STT/LLM/TTS language), `micMode` (`off` / `full` / `stt_only`) |
| `characters` | Character profiles (Настройки → Персонаж): `activeId` and `profiles`, each `{ id, displayName, characterName, description, voice: { provider, id } }`. Empty `description` = default persona of the language pack, empty voice `id` = default voice (`xenia`). The built-in profile `default` always exists. Damaged entries are repaired on load and reported in the log. See `docs/legacy/VC_M1_2_CHARACTER_PROFILES_VOICE.md` |
| `avatar` | `engine` — движок анимации фото (`none`: фото статично, речь локально); `photo` — абсолютный путь к фото (JPG/PNG/WEBP/BMP, до 25 МБ), задаётся через Настройки → Фото и анимация или кнопку на фото в чате |
| `persona` | `prompt` — the single persona of VC-M0 / VC-M1.1. Still read from an old `user.json` and moved into the built-in character profile; not written any more |
| `llm` | `endpoint`, `model` (empty = auto), `temperature`, `topP`, `topK`, `maxTokens` (limit for the answer), `disableThinking` (default true: `reasoning_effort: "none"` is sent), `reasoningBudgetTokens` (extra tokens allowed only when the model thinks anyway, default 2048) |
| `session` | `historyTurns` (0–20, default 10) |
| `stt` | `model` (`small` / `base`), `device` (`cuda` / `cpu`), `computeType`, `beamSize` — no language key: it comes from `conversation.language` |
| `tts` | `modelId` (empty = model of the language pack), `device`, `sentenceStreaming`, `output` (`local` / `avatar`: through the photo-animation engine; falls back to local while no engine can play speech). `voice` is the single voice of VC-M0 / VC-M1.1: still read from an old `user.json` and moved into the built-in character profile; the voice now belongs to the profile (`characters`) |
| `vad` | `minSilenceMs` (end-of-speech wait), `threshold`, `minSpeechMs`, `speechPadMs`, `maxUtteranceSec` |
| `audio` | `inputDevice`, `outputDevice` (empty = system default), `hostApi`, `listenResumeDelayMs` |
| `ui` | `theme` (`system` / `light` / `dark`), `language` (interface language, independent of the conversation language) |
| `service` | `pythonPath` (empty = `.venv`) |
