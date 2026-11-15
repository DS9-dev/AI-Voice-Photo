# VC-M1.1 — Natural Conversation Behavior

**Status: `VAMVOICECOMPANION_VC_M1_1_NATURAL_CONVERSATION_PASS`** — closed
on 2026-10-07 with the user's verdict
`USER_NATURAL_CONVERSATION_ACCEPTANCE: PASS` after a manual conversation
review (see [Manual acceptance](#manual-acceptance)). The accepted contract is
frozen: do not weaken or alter it, and do not tune it further merely to
satisfy the automated evaluation.

Base: VC-M0, commit `c8e0bb2b8e1d75c044decc51cef84a323c9e42d2`.

## The problem

With the VC-M0 prompt the companion spoke Russian, briefly and in plain
speakable text, but she ran the conversation like an assistant: offered to
change the subject, asked what to talk about, offered help and pastimes nobody
asked for, and closed almost every reply with a question, often a menu
("X или Y?"). Measured on the target model with the frozen VC-M0 prompt
(99 replies): 15 replies managed the conversation or offered a service, 75
ended with a question, 34 of them with an "X or Y?" question.

VC-M1.1 changes one thing: the protected part of the system prompt now says how
to take part in a conversation. Nothing else in the application changed.

## Where the behaviour is defined

```
[ЛИЧНОСТЬ]                 editable persona            (config persona.prompt; default unchanged)
[КАК ВЕСТИ РАЗГОВОР]       protected contract          (new in VC-M1.1)
[ПРАВИЛА СИСТЕМЫ]          protected system rules      (VC-M0, unchanged, still last)
— session history —
— the user's turn —
```

| Part | Owner | Defined in |
|---|---|---|
| Persona | the user (Настройки → Личность компаньона) | `config persona.prompt`; default text in the language pack |
| Natural-conversation contract | the application | `LANGUAGES.<code>.llm.conversation` in `core/language/languages.js` |
| System rules | the application | `directive` + `coreRules` in the same language pack |

- **One definition.** The contract text exists in exactly one place
  (`core/language/languages.js`); `buildSystemPrompt(pack, persona)` is the only
  code that assembles a system prompt. A test fails if the text appears
  anywhere else in `core`, `app`, `services`, `scripts` or `config`.
- **Protected.** The contract has no configuration key and no editor. Whatever
  the persona says, the protected core is appended unchanged and has the last
  word. Settings shows it read-only together with the system rules (the
  existing read-only block; no new field).
- **Not in the persona.** The default persona is byte-identical to VC-M0.
- **Language architecture kept.** The contract is text of a language pack,
  like the system rules. The assembly is the same for every pack; a pack
  without a contract simply has no such section (tested with a synthetic
  English pack). Nothing outside the pack contains Russian behaviour text.
- **No runtime filter.** No reply is checked, rewritten or blocked. The
  detector described below is loaded only by tests and by the evaluation
  script; a test asserts that `core`, `app` and `services` never load it.

Why the contract sits between the persona and the system rules: placed after
the system rules it made the model refuse an explicit request for help
("Сейчас не могу выбирать за тебя…"); in the middle it did not. The system
rules stay last, unchanged, with their closing sentence that the rules
override the persona.

## The contract

`[КАК ВЕСТИ РАЗГОВОР]` — an opening line, eight rules, three sample exchanges.
Opening line: *Ты собеседница: участвуешь в разговоре, а не ведёшь его и не
обслуживаешь собеседника.*

| # | Rule id | What it asks for | Requirement |
|---|---|---|---|
| 1 | `stay_on_topic` | Stay with the current topic. The user or the conversation changes it; she does not offer to change it and does not ask what to talk about | 3.1, 3.9 |
| 2 | `no_forced_question` | Do not end a reply with a question out of habit; a reply normally ends with a statement. Ask sometimes, out of real curiosity: one short direct question, no options through «или» | 3.3, 3.8 |
| 3 | `no_unrequested_offers` | Unasked: no offers of help, support or pastimes, no advice, no description of what she can do, no "come to me if you need anything" | 3.2, 3.7 |
| 4 | `sympathy_not_solutions` | Do not tell the user what to do. A complaint gets sympathy or her own experience, not treatment, rest orders or entertainment | 3.5 |
| 5 | `short_replies_are_fine` | A short reply is a normal reply; answer «ага», «понятно» equally briefly and do not ask why he is terse | 3.4 |
| 6 | `social_not_explanatory` | React to everyday and personal remarks like a person — a reaction, an impression, a joke — not with explanations and summaries | 3.5, 3.6 |
| 7 | `stay_engaged` | Do not be passive: agree and argue, joke, say what she thinks, add something of her own on the same topic | 3.10 |
| 8 | `help_when_asked` | When the user asks — to help choose, advise, explain, tell, change the topic — do it at once and willingly; do not refuse, joke it away or ask why | 3.9, help |

The exact Russian text is in `core/language/languages.js` and, as sent to the
model, in Настройки → Личность компаньона → «Как вести разговор и правила
системы».

The VC-M0 spoken-output rules (short, plain speakable Russian, no markup,
lists, code or emoji, no claimed physical actions) are untouched: the frozen
VC-M0 prompt is exactly the current prompt minus the new section, and a test
checks that.

## How the wording was chosen

The wording was chosen by measurement on the target model (LM Studio,
`qwen/qwen3.5-9b`, application sampling settings), about 2000 replies over
seventeen drafts, scored with the detector below and read by eye. What the measurements
showed, because it matters for anyone who edits the text later:

| Observation | Consequence |
|---|---|
| The contract after the system rules made her deflect a request for help | It sits before them |
| Without sample exchanges replies were longer and ended with a question more often | Three samples are kept |
| A sample with a question pushed the share of questions up | No sample contains a question |
| Samples are copied. With «— Ну ладно. — Угу.» she opened unrelated replies with «Угу»; with samples about a headache or boredom she answered every such complaint with the same sentence | Samples are few and neutral (a late bus, a barking dog, bitter coffee); none is about tiredness or pain |
| Naming an activity in a prohibition ("do not send him to rest, sleep, walk…") made her suggest exactly that more often | Rules do not list the things she must not suggest |
| Quoting phrases to avoid did not reduce them | No quoted "bad phrases" in the rules |
| No wording reduced advice after "I am tired / sleepy / my back hurts" | Known limitation, see below |

## Evaluation

Two tools, both evaluation-only.

**Detector** — `scripts/lib/assistantism.js`. Recognizes known classes of
assistant-style behaviour in a reply, in the context of what the user said:

| Group | Classes |
|---|---|
| managing the conversation or offering services | `topic_change_offer`, `asks_what_to_talk_about`, `topic_menu`, `unrequested_help`, `conditional_offer` ("если хочешь, я могу…", "хочешь, я…"), `capability_advert`, `activity_offer` |
| unrequested advice | `unrequested_advice` |
| article style | `summary_closer`, `lecture` |

Context: an offer or advice is not a finding when the user asked for help or
advice; talking about a new topic is not a finding when the user asked to
change it; «Если хочешь кофе, он на кухне» and «Я могу…» in answer to «Что
ещё ты можешь сделать?» are not findings. A question is never a finding. The
detector knows phrasings, not meaning: it under-counts, it can mislabel, and a
reply without findings is not thereby natural.

**Scenario run** — `scripts/lib/conversationEval.js`, started with
`conversation_eval.bat` (or `npm run conversation-eval`). It uses the
application's own path — `resolveLanguageProfile` → `SessionHistory` →
`buildMessages` → `LMStudioProvider.streamChat` — with the configured settings:
no evaluation-only prompt, no changed sampling, no filtering. It plays each
scenario several times (default 3), records every reply with input, output,
detector findings, length, whether it ends with a question, latency and token
counts, and, while the default persona is in use, plays the frozen VC-M0 prompt
first for a controlled before/after (same model, settings, scenarios and code;
the frozen prompt is `scripts/lib/baselines/vc_m0_system_prompt.ru.txt`,
reconstructed from commit `c8e0bb2`, checked by SHA-256 in a test).

| Set | Scenarios |
|---|---|
| required | A «Сегодня хорошая погода.» · B «Я сегодня немного устал.» · C «Мне этот фильм вообще не понравился.» · D «Я вчера несколько часов возился с компьютером.» · E …then «Ладно, понятно.» · F …then «Ладно, давай лучше поговорим про фильмы.» · G «Я сегодня купил себе новую видеокарту.» · H «Поможешь мне выбрать фильм на вечер?» |
| multi_turn | M small talk over tea ending with «Что-то спать хочется.» · N a series, short answers |
| complaints | I headache · J boredom · K a direct question about her opinion · L a quarrel at work, then «Угу.» |
| held_out | P back pain · Q overtime · R overslept · S a fishing trip, short answers · T «Расскажи что-нибудь интересное.» · U «Как думаешь, стоит мне сегодня идти в спортзал?» |

The first three sets were played while the wording was being chosen. The
`held_out` set was written afterwards and played for the first time in the
recorded run; do not tune the wording on it. Two scenarios carry explicit
protections, checked on every run: F must go along with the requested topic,
H must take up the request and must not decline.

```
conversation_eval.bat                 working report: artifacts/reports/conversation_eval.json
conversation_eval.bat --runs 5        more samples
conversation_eval.bat --record        also replaces the recorded evidence (VC_M1_1_EVALUATION.json)
                                      and regenerates VC_M1_1_COMPLETION.json
```

The script reports numbers and lists the replies with findings. It gives no
verdict on naturalness.

### Recorded result

`artifacts/reports/VC_M1_1_EVALUATION.json`, 2026-10-06, `qwen/qwen3.5-9b`,
default persona, temperature 0.7 / top_p 0.8 / top_k 20 / max_tokens 300,
thinking switched off by `reasoning_effort: "none"`, 3 runs, 99 replies per
prompt, all answered.

| | VC-M0 prompt | VC-M1.1 prompt |
|---|---|---|
| Replies with any finding | 24 | 17 |
| … managing the conversation or offering services | **15** | **5** |
| … unrequested advice | **13** | **13** |
| Replies ending with a question (descriptive) | 75 | 58 |
| Replies with an "X or Y?" question (descriptive) | 34 | 12 |
| Mean / median words per reply | 19.4 / 17 | 15.8 / 14 |
| Mean completion tokens per reply | 34.8 | 28.2 |
| Scenario protections (F follows the topic, H helps) | 8/9 | 9/9 |
| Replies breaking the spoken-output rules | 1 | 1 |

(A reply can be in both groups. The one protection missed with the VC-M0
prompt is a reply about films that contains none of the check's film words.)

By set, replies with a finding (managing or offering / advice), out of the
replies in the set:

| Set | VC-M0 prompt | VC-M1.1 prompt |
|---|---|---|
| required (30) | 7 (4 / 3) | 5 (1 / 4) |
| multi_turn (27) | 2 (2 / 0) | 4 (2 / 3) |
| complaints (18) | 9 (8 / 4) | 4 (1 / 3) |
| held_out (24) | 6 (1 / 6) | 4 (1 / 3) |

Representative replies with the VC-M1.1 prompt:

| User | Companion |
|---|---|
| Сегодня хорошая погода. | Да, солнце сегодня вообще чудесно светит. |
| … Ладно, понятно. | Ну да, ничего страшного. |
| Мне этот фильм вообще не понравился. | Ага, ну бывает же так. Что именно не зашло? Сюжет или герои? |
| Я сегодня купил себе новую видеокарту. | Звучит отлично! Какую именно модель взял? |
| Я сегодня купил себе новую видеокарту. | Ого, серьёзно? Это же круто! Теперь твой компьютер точно будет летать в играх. |
| … Ладно, давай лучше поговорим про фильмы. | Хорошо, я люблю кино. А ты что-то особенно интересное смотрел в последнее время? |
| Поможешь мне выбрать фильм на вечер? | Конечно, с удовольствием. Только скажи, что тебе сейчас по настроению ближе: что-то веселое и легкое или, может быть, спокойное кино для уюта? |
| Я сегодня проспал и опоздал. | Ну да, бывает. Утро всё равно самое сложное время. |
| Я сегодня на работе с начальником поругался. | Ох, как же неприятно, когда всё идёт не по плану. Что он сказал? |

The same inputs with the VC-M0 prompt, same run:

| User | Companion |
|---|---|
| Сегодня хорошая погода. | Да, действительно, солнышко греет, и воздух такой свежий. Хочешь прогуляться немного или лучше останемся здесь? |
| … Ладно, понятно. | Хорошо, если есть вопросы — обращайся. А то вдруг захочешь кофе выпить или просто посидеть подольше? |
| Я сегодня немного устал. | Понимаю, бывает. Может, просто выпьем чаю и посидим в тишине? Или тебе хочется поговорить о чём-нибудь лёгком, чтобы отвлечься? |
| Что-то мне скучно. | Давай сыграем в какую-нибудь игру или просто поболтаем? Я сейчас слушаю, что тебе интересно. |
| … Угу. (after the quarrel at work) | Ладно, тогда давай просто поболтаем о чём-нибудь легком. Ты любишь кофе или, может быть, чай лучше пьёшь? |

### Detected failures with the VC-M1.1 prompt

All 17 are listed in the evaluation file (`variants.current.detectedFailures`).
By kind:

- **Unrequested advice, 13 replies** — the same number as before. Scenario B
  (required) in 3 of 3 runs: «Ну да, бывает. Может, лучше чуть отдохнуть?»;
  sleepiness at the end of M in 2 of 3; headache, back pain, overtime,
  boredom: «Может, лучше немного полежать?», «Лучше прямо сейчас выдохни и
  займись чем-то приятным…».
- **Offers, 4 replies**: «Хочешь, я могу принести тебе воды?» (also an offer of
  a physical action), «Хочешь, я дам тебе пару советов, как её расслабить?»,
  «Просто скажи, если вдруг захочешь порекомендовать что-то получше…»,
  «Может, посоветую что-то свежее, если хочешь» (after the user changed the
  topic to films).
- **Offer to change the subject, 1 reply** (labelled so by the detector; it is
  advice in substance): «Может, лучше переключиться на что-то поспокойнее?».

Seen by eye and not counted by the detector: a phrase from a sample exchange
reused once where it did not fit («…особенно если кофе был горьким» in the tea
conversation) and once where it did («Как всегда, когда торопишься» after
"overslept and was late"); a curt reply to «Ладно, понятно.» («Ну да, иди
своей дорогой.»); a probing reply to a short answer («Хм, странно, обычно люди
сразу называют название…»); one English word («lately»); feminine forms or
«вы» addressed to the user.

### Known limitations

1. **Unrequested advice is not reduced.** When the user says he is tired,
   sleepy or in pain, the model still tends to tell him to rest. Six wordings
   of rule 4 and several sample exchanges were measured; none changed it
   reliably, and samples about complaints were repeated word for word. This
   is the one required behaviour (scenario B) the contract does not deliver.
   It was not "solved" with a runtime filter: censoring replies is excluded as
   the primary solution by the task, and nothing of the kind was added. If it
   matters in the manual acceptance, the options are a decision for the user:
   accept it as the model's caring habit, address it in the persona stage, try
   another model, or explicitly approve a narrow, visible defensive mechanism.

   **Decision (user, 2026-10-07): accepted as non-blocking.** In real
   conversation the unsolicited advice is acceptable. The automated findings
   (scenario B in 3 of 3 runs, 13 of 99 replies) stay in the evaluation as
   recorded, and scenario B is not to be tuned merely to satisfy the
   evaluator.
2. **Questions remain frequent.** 58 of 99 replies still end with a question
   (75 before); "X or Y?" questions fell from 34 to 12. Question frequency is
   not a failure criterion; forced questions are judged by the user.
3. **Samples leak.** See above. Do not add samples about topics the user is
   likely to raise.
4. **A prompt is not a guarantee.** Sampling is random; counts vary between
   runs, and with 99 replies small differences are noise.
5. **Out of scope and unchanged:** wrong grammatical gender or «вы» for the
   user, occasional foreign words, an offer of a physical action despite
   system rule 5 (persona and later stages).

## Effect on length, tokens and latency

Observed in the recorded run, not a target:

| | VC-M0 prompt | VC-M1.1 prompt |
|---|---|---|
| System prompt | 1268 characters | 3225 characters |
| Prompt tokens of a first turn (system prompt + one line) | 374 | 968 |
| Mean completion tokens per reply | 34.8 | 28.2 |
| Median time to the first answer text | 195 ms | 199 ms |
| Median time to the complete answer | 594 ms | 513 ms |

The system prompt is about 600 tokens longer. LM Studio reuses the evaluated
prompt prefix between requests, so the longer prompt was paid for once: the
first request after the prompt changed took 368 ms to the first answer text
(620 ms for the first request of the baseline pass, which also carried the
model's warm-up), later ones about 200 ms with either prompt. Replies are
shorter, so there is slightly less text to synthesize. The full voice latency
(speech end → first audible answer; VC-M0: median 1756 ms) was not re-measured
in this stage; `live_acceptance.bat` measures it.

## Regression protection

Automated: the whole VC-M0 suite still runs, plus the VC-M1.1 tests
(`tests/core/naturalConversation.test.js`, `assistantism.test.js`,
`conversationEval.test.js`, `vcM11Report.test.js`). The three existing tests
that pinned the exact prompt layout were updated to the new layout with the
same strictness (exact string equality).

Not changed in VC-M1.1: the voice service (VAD, STT, TTS, audio), the LLM
provider and its thinking control, the orchestrator and state machine, session
history, process ownership, configuration defaults, the persona editor. The
only application files changed are `core/language/languages.js` (the contract
and its assembly) and one UI string (the title of the read-only block).

## Manual acceptance

Automated checks cannot decide whether a conversation feels human. The stage
is accepted by the user only.

1. Start LM Studio's local server with `qwen/qwen3.5-9b` loaded.
2. Start the application with `start.bat`. In Настройки → Личность компаньона
   keep the default persona (press «Сбросить по умолчанию» if it was edited)
   and open «Как вести разговор и правила системы» once to see the new section.
3. Press «Очистить сессию», switch the microphone on and talk for 5–10 minutes.
   Nothing is scripted; try to cover:
   - a casual observation;
   - a personal statement;
   - an opinion;
   - a hobby or something you did;
   - a short acknowledgement («ага», «понятно», «ну да»);
   - several turns in a row on one topic;
   - a natural change of topic that you start;
   - one explicit request for help.
4. Judge:
   1. Does she still repeatedly offer to change the subject?
   2. Does she repeatedly say variants of «если хочешь, я могу…»?
   3. Does she behave like a service assistant?
   4. Does she force unnecessary follow-up questions?
   5. Can an answer end naturally?
   6. Does she remain capable of genuine curiosity?
   7. Does she remain engaged rather than becoming passive?
   8. Does the conversation feel more like talking with a person nearby?

   Keep limitation 1 in mind when you mention tiredness or feeling unwell: she
   will probably still suggest a rest. Whether that is acceptable is part of
   the verdict.
5. Give the verdict:

   ```
   USER_NATURAL_CONVERSATION_ACCEPTANCE: PASS / FAIL
   ```

### Result

`USER_NATURAL_CONVERSATION_ACCEPTANCE: PASS` — stated by the user on
2026-10-07 after a manual conversation review:

- topic-change / conversation-management behaviour is no longer a problem;
- the companion naturally maintains the current topic;
- she periodically develops the topic further on her own;
- the conversation does not feel passive;
- the observed unsolicited advice is acceptable in real conversation and is
  not a blocker.

With it the user gave two directions for later work: do not further tune
scenario B merely to satisfy the automated evaluator, and do not weaken or
alter the accepted natural-conversation behaviour.

### How the verdict is recorded

The verdict is recorded in
`artifacts/reports/user_natural_conversation_acceptance.json`
(`{"verdict": "PASS" | "FAIL", "statedBy": "user", "date": "…", "notes": "…"}`)
only after the user has stated it; `npm run report:m1.1` then regenerates
`VC_M1_1_COMPLETION.json`. Without that file the completion report cannot say
PASS: it keeps `AUTOMATED_REGRESSION`, `REAL_MODEL_EVALUATION` and
`USER_MANUAL_ACCEPTANCE` apart, and the stage status is
`VAMVOICECOMPANION_VC_M1_1_NATURAL_CONVERSATION_PASS` only when the tests
pass, the evaluation is recorded and the user's verdict is PASS. The verdict
does not change the evaluation section: detected failures stay listed, and
what the user accepted as non-blocking is recorded beside them
(`USER_MANUAL_ACCEPTANCE.acceptedNonBlocking`).

## Files

| File | Role |
|---|---|
| `core/language/languages.js` | the contract (`llm.conversation`) and the prompt assembly |
| `app/renderer/strings.js` | title of the read-only block in Settings |
| `scripts/lib/assistantism.js` | evaluation-only detector |
| `scripts/lib/conversationEval.js`, `scripts/conversation_eval.js`, `conversation_eval.bat` | scenario run against the real model |
| `scripts/lib/baselines/vc_m0_system_prompt.ru.txt` | frozen VC-M0 prompt for the before/after |
| `scripts/make_vc_m1_1_report.js` | completion report from recorded evidence |
| `tests/core/naturalConversation.test.js`, `assistantism.test.js`, `conversationEval.test.js`, `vcM11Report.test.js` | tests |
| `artifacts/reports/VC_M1_1_EVALUATION.json`, `VC_M1_1_COMPLETION.json` | recorded evidence |
| `artifacts/reports/user_natural_conversation_acceptance.json` | the user's verdict |

Not part of this stage: VC-M1.2 Persona, VC-M1.3 Conversation Dynamics,
VC-M1.4 STT Quality, VC-M2 Commands, VaM and VaMTools integration.
