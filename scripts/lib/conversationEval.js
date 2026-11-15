'use strict';
/**
 * Natural-conversation evaluation (VC-M1.1).
 *
 * Plays fixed Russian scenarios against the LLM through the SAME path a
 * conversation takes in the application:
 *   resolveLanguageProfile(config).llm.systemPrompt   (persona + protected core)
 *   SessionHistory                                    (bounded session history)
 *   buildMessages                                     (system + history + user turn)
 *   LMStudioProvider.streamChat                       (the configured generation settings)
 * No evaluation-only prompt, no changed sampling settings, no filtering of the
 * replies. Every reply is recorded as it came back and then described by the
 * evaluation-only detector (scripts/lib/assistantism.js).
 *
 * What the result means:
 *   - the detector recognizes KNOWN classes of assistant-style behaviour. A
 *     reply without findings is not thereby natural;
 *   - how often a reply ends with a question is reported, never judged;
 *   - whether the conversation feels human is decided by the user in the
 *     manual acceptance, not by this script.
 *
 * Transport-agnostic (unit tested against the fake server); only
 * scripts/conversation_eval.js runs it against the real LM Studio.
 */
const { LMStudioProvider } = require('../../core/providers/lmStudioProvider');
const { resolveLanguageProfile } = require('../../core/language/languages');
const { buildMessages } = require('../../core/conversation/prompt');
const { turnHintFor, withTurnHint } = require('../../core/conversation/turnHints');
const { SessionHistory } = require('../../core/session/sessionHistory');
const { analyzeReply } = require('./assistantism');

const FILM_TALK = /фильм|кино|смотр|сериал|комеди|жанр|драм|боевик|ужас|триллер|мульт/i;
// taking up "help me choose a film": film words, or the vocabulary of choosing (mood, options, light or serious)
const TAKES_UP_CHOICE = new RegExp(`${FILM_TALK.source}|помогу|выбер|выбир|подбер|вариант|настроени|смешн|вес[её]л|л[её]гк|спокойн|серь[её]зн|атмосферн|посовету|предлож`, 'i');
const DECLINES = /(?:не\s+(?:могу|буду|стану|хочу)\s+(?:тебе\s+)?(?:помо|выбир|совет)|выбирай\s+сам|сам\s+выбирай|зачем\s+(?:тебе|я\s+тебе)\s+(?:моя\s+)?помощ|сейчас\s+не\s+могу)/i;

/**
 * The scenarios. `turns` are the user's lines of one conversation, in order.
 *   set: required    the scenarios named by the VC-M1.1 task (A–H)
 *        multi_turn  longer everyday conversations (short answers, tiredness)
 *        complaints  complaints, a quarrel, a direct question
 *        held_out    never played while the wording of the contract was being
 *                    chosen (the three sets above were): they show how the
 *                    contract generalizes. Do not tune the wording on them.
 * `expect` are scenario-specific protections, checked on the reply to the given
 * turn (0-based): the contract must not stop the companion from following a
 * requested topic change or from helping when asked.
 */
const SCENARIOS = [
  { id: 'A', set: 'required', title: 'simple observation', turns: ['Сегодня хорошая погода.'] },
  { id: 'B', set: 'required', title: 'personal statement (tired)', turns: ['Я сегодня немного устал.'] },
  { id: 'C', set: 'required', title: 'opinion (disliked a film)', turns: ['Мне этот фильм вообще не понравился.'] },
  { id: 'D', set: 'required', title: 'statement about an activity', turns: ['Я вчера несколько часов возился с компьютером.'] },
  { id: 'E', set: 'required', title: 'short acknowledgement after an exchange', turns: ['Сегодня хорошая погода.', 'Ладно, понятно.'] },
  {
    id: 'F', set: 'required', title: 'the user changes the topic', turns: ['Я вчера несколько часов возился с компьютером.', 'Ладно, давай лучше поговорим про фильмы.'],
    expect: [{ turn: 1, id: 'follows_topic_change', title: 'goes along with the requested topic (talks about films)', mustMatch: FILM_TALK }],
  },
  { id: 'G', set: 'required', title: 'news that invites curiosity', turns: ['Я сегодня купил себе новую видеокарту.'] },
  {
    id: 'H', set: 'required', title: 'explicit request for help', turns: ['Поможешь мне выбрать фильм на вечер?'],
    expect: [
      { turn: 0, id: 'engages_with_request', title: 'takes up the request (talks about choosing a film)', mustMatch: TAKES_UP_CHOICE },
      { turn: 0, id: 'does_not_decline', title: 'does not decline or deflect the request', mustNotMatch: DECLINES },
    ],
  },
  { id: 'M', set: 'multi_turn', title: 'small talk over tea, ends with sleepiness', turns: ['Привет.', 'Да так, сижу, чай пью.', 'Чёрный, с лимоном.', 'Ага.', 'Что-то спать хочется.'] },
  { id: 'N', set: 'multi_turn', title: 'talking about a series, short answers', turns: ['Знаешь, я вчера наконец досмотрел тот сериал.', 'Про космос, длинный такой.', 'Концовка так себе.', 'Ну да.'] },
  { id: 'I', set: 'complaints', title: 'complaint (headache)', turns: ['У меня с утра голова болит.'] },
  { id: 'J', set: 'complaints', title: 'boredom', turns: ['Что-то мне скучно.'] },
  { id: 'K', set: 'complaints', title: 'direct question about her opinion', turns: ['Как тебе вообще дождливая погода?'] },
  { id: 'L', set: 'complaints', title: 'quarrel at work, then a short answer', turns: ['Я сегодня на работе с начальником поругался.', 'Да он опять придрался к отчёту.', 'Угу.'] },
  { id: 'P', set: 'held_out', title: 'complaint (back pain)', turns: ['Спина что-то разболелась.'] },
  { id: 'Q', set: 'held_out', title: 'complaint (overtime)', turns: ['Опять на работе завал, домой приду поздно.'] },
  { id: 'R', set: 'held_out', title: 'mishap', turns: ['Я сегодня проспал и опоздал.'] },
  { id: 'S', set: 'held_out', title: 'a story with short answers', turns: ['Мы вчера с другом на рыбалку ездили.', 'Да почти ничего не поймали.', 'Ну такое.'] },
  { id: 'T', set: 'held_out', title: 'explicit request to tell something', turns: ['Расскажи что-нибудь интересное.'] },
  { id: 'U', set: 'held_out', title: 'explicit request for advice', turns: ['Как думаешь, стоит мне сегодня идти в спортзал?'] },
];

const ms = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.round(b - a) : null);

/**
 * Things the spoken-output rules of VC-M0 forbid (markup, lists, emoji, Latin
 * script, digits, stage directions). Descriptive: shows that the new section
 * did not loosen the spoken-answer contract.
 */
function spokenIssues(reply) {
  const text = String(reply || '');
  const issues = [];
  if (/[*_#`~]|^\s*[-•]\s/m.test(text) || /^\s*\d+[.)]\s/m.test(text)) issues.push('markup_or_list');
  if (/\p{Extended_Pictographic}/u.test(text)) issues.push('emoji');
  if (/[A-Za-z]{2,}/.test(text)) issues.push('latin_script');
  if (/\d/.test(text)) issues.push('digits');
  if (/[([][^)\]]{0,60}[)\]]/.test(text)) issues.push('stage_direction');
  if (/[㐀-鿿぀-ヿ가-힯]/.test(text)) issues.push('other_script');
  return issues;
}

/**
 * Play every scenario `runs` times. Returns raw records, one per reply:
 *   {scenario, run, turn, user, reply, outcome, error, ttftMs, firstContentMs, totalMs, promptTokens, completionTokens}
 */
async function collectConversations({ provider, model, systemPrompt, historyTurns, scenarios = SCENARIOS, runs = 3, say = () => {}, turnHint = null }) {
  const records = [];
  for (const sc of scenarios) {
    for (let run = 1; run <= runs; run++) {
      const history = new SessionHistory({ maxTurns: historyTurns });
      for (let turn = 0; turn < sc.turns.length; turn++) {
        const user = sc.turns[turn];
        // the application's per-turn note (core/conversation/turnHints.js), when the caller passes its decision
        const hint = turnHint ? turnHint(user) : { note: null, applied: [] };
        const messages = buildMessages({ systemPrompt, historyMessages: history.getMessages(), userText: withTurnHint(user, hint.note) });
        const rec = { scenario: sc.id, run, turn, user, reply: '', outcome: null, error: null, ttftMs: null, firstContentMs: null, totalMs: null, promptTokens: null, completionTokens: null };
        if (hint.applied.length) rec.turnHints = hint.applied.join(' ');
        try {
          const r = await provider.streamChat({ model, messages });
          Object.assign(rec, {
            reply: String(r.text || '').trim(), outcome: r.outcome,
            ttftMs: ms(r.timings.tRequest, r.timings.tFirstToken), firstContentMs: ms(r.timings.tRequest, r.timings.tFirstContent), totalMs: ms(r.timings.tRequest, r.timings.tDone),
            promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens,
          });
        } catch (err) {
          rec.outcome = err.outcome || 'request_failed';
          rec.error = err.message;
        }
        records.push(rec);
        say(`  ${sc.id}.${run}${sc.turns.length > 1 ? `.${turn + 1}` : ''}  > ${user}`);
        say(`        < ${rec.reply || `(no answer: ${rec.outcome}${rec.error ? ` — ${rec.error}` : ''})`}`);
        if (!rec.reply) break; // a conversation cannot continue without the reply
        history.addTurn(user, rec.reply);
      }
    }
  }
  return records;
}

const median = (values) => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
};
const mean1 = (values) => {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};

function summarize(replies) {
  const answered = replies.filter((r) => r.outcome === 'ok' && r.reply);
  const byClass = {};
  for (const r of answered) for (const c of r.detector.classes) byClass[c] = (byClass[c] || 0) + 1;
  const expectations = replies.flatMap((r) => r.expectations || []);
  return {
    replies: replies.length,
    answered: answered.length,
    assistantLike: answered.filter((r) => r.detector.assistantLike).length,
    // the two kinds of findings behave differently, so they are also counted apart (a reply can be in both)
    managementLike: answered.filter((r) => r.detector.groups.includes('management')).length,
    adviceLike: answered.filter((r) => r.detector.groups.includes('advice')).length,
    byClass,
    endsWithQuestion: answered.filter((r) => r.shape.endsWithQuestion).length,
    choiceQuestion: answered.filter((r) => r.shape.choiceQuestion).length,
    withSpokenIssues: answered.filter((r) => r.spokenIssues.length).length,
    expectationsMet: expectations.filter((e) => e.met).length,
    expectationsTotal: expectations.length,
    words: { mean: mean1(answered.map((r) => r.shape.words)), median: median(answered.map((r) => r.shape.words)), max: answered.length ? Math.max(...answered.map((r) => r.shape.words)) : null },
    chars: { mean: mean1(answered.map((r) => r.shape.chars)) },
    completionTokens: { mean: mean1(answered.map((r) => r.completionTokens)) },
    latencyMs: { firstContentMedian: median(answered.map((r) => r.firstContentMs)), totalMedian: median(answered.map((r) => r.totalMs)) },
  };
}

/** Describe raw records: detector, shape, spoken-format issues, scenario protections; then count. */
function analyzeRecords(records, scenarios = SCENARIOS) {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const replies = records.map((rec) => {
    const sc = byId.get(rec.scenario) || { set: 'unknown', turns: [] };
    const a = analyzeReply({ user: rec.user, reply: rec.reply });
    const expectations = (sc.expect || []).filter((e) => e.turn === rec.turn && rec.reply).map((e) => ({
      id: e.id, title: e.title,
      met: (e.mustMatch ? e.mustMatch.test(rec.reply) : true) && (e.mustNotMatch ? !e.mustNotMatch.test(rec.reply) : true),
    }));
    return {
      ...rec,
      set: sc.set,
      detector: { assistantLike: a.assistantLike, classes: a.classes, groups: a.groups, findings: a.unsolicited.map((f) => ({ class: f.class, sentence: f.sentence })), solicited: a.findings.filter((f) => f.solicited).map((f) => f.class) },
      shape: a.shape,
      spokenIssues: spokenIssues(rec.reply),
      expectations,
    };
  });
  const perScenario = {};
  for (const sc of scenarios) {
    const mine = replies.filter((r) => r.scenario === sc.id);
    if (mine.length) perScenario[sc.id] = { set: sc.set, title: sc.title, ...summarize(mine) };
  }
  const perSet = {};
  for (const set of [...new Set(scenarios.map((s) => s.set))]) {
    const mine = replies.filter((r) => r.set === set);
    if (mine.length) perSet[set] = summarize(mine);
  }
  // prompt size as the server counted it: the smallest request is "system prompt + one short line"
  const firstTurns = replies.filter((r) => r.turn === 0 && Number.isFinite(r.promptTokens)).map((r) => r.promptTokens);
  return {
    summary: { ...summarize(replies), promptTokensFirstTurn: firstTurns.length ? Math.min(...firstTurns) : null },
    perSet,
    perScenario,
    detectedFailures: replies.filter((r) => r.detector.assistantLike).map((r) => ({ scenario: r.scenario, run: r.run, turn: r.turn, user: r.user, reply: r.reply, classes: r.detector.classes })),
    failedExpectations: replies.flatMap((r) => r.expectations.filter((e) => !e.met).map((e) => ({ scenario: r.scenario, run: r.run, turn: r.turn, expectation: e.id, user: r.user, reply: r.reply }))),
    replies,
  };
}

/** Numbers of two analyzed variants side by side (no verdict). */
function compareVariants(before, after) {
  const row = (name, pick) => ({ metric: name, before: pick(before.summary), after: pick(after.summary) });
  const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return [
    row('answered replies', (s) => s.answered),
    row('replies with assistant-style findings', (s) => s.assistantLike),
    row('… as % of answered', (s) => rate(s.assistantLike, s.answered)),
    row('… of them: managing the conversation or offering services', (s) => s.managementLike),
    row('… of them: unrequested advice', (s) => s.adviceLike),
    row('replies ending with a question (descriptive)', (s) => s.endsWithQuestion),
    row('… as % of answered', (s) => rate(s.endsWithQuestion, s.answered)),
    row('replies with an "X or Y?" question (descriptive)', (s) => s.choiceQuestion),
    row('mean words per reply', (s) => s.words.mean),
    row('median words per reply', (s) => s.words.median),
    row('mean completion tokens per reply', (s) => s.completionTokens.mean),
    row('prompt tokens, first turn (system prompt + one line)', (s) => s.promptTokensFirstTurn),
    row('median time to first answer text, ms', (s) => s.latencyMs.firstContentMedian),
    row('median time to complete answer, ms', (s) => s.latencyMs.totalMedian),
    row('replies breaking the spoken-output rules', (s) => s.withSpokenIssues),
    row('scenario protections met', (s) => `${s.expectationsMet}/${s.expectationsTotal}`),
  ];
}

const LIMITS = [
  'The detector recognizes known classes of assistant-style behaviour; a reply without findings is not thereby natural.',
  'Ending with a question is reported, not judged: a question out of real curiosity is wanted behaviour.',
  'Sampling is random (application temperature), so counts vary between runs.',
  'Whether the conversation feels human is decided by the user (manual acceptance), not by this report.',
];
const CURRENT_TITLE = 'the application\'s current system prompt (persona + protected core with the natural-conversation contract)';

/**
 * The report from raw records.
 *   variants  [{id, title, provenance, systemPrompt, records}], baseline first when there is one
 */
function buildReport({ config, model, runs, scenarios = SCENARIOS, variants, thinkingControl = null, generatedAt = new Date().toISOString() }) {
  const profile = resolveLanguageProfile(config);
  const report = {
    stage: 'VC-M1.1', kind: 'REAL_MODEL_EVALUATION', generatedAt,
    endpoint: config.llm.endpoint, model, ok: false,
    promptPath: 'resolveLanguageProfile → SessionHistory → buildMessages → LMStudioProvider.streamChat (the application modules, application settings)',
    settings: { temperature: config.llm.temperature, topP: config.llm.topP, topK: config.llm.topK, maxTokens: config.llm.maxTokens, disableThinking: config.llm.disableThinking, historyTurns: config.session.historyTurns },
    perTurnNotes: { premiseCheck: Boolean(config.conversation && config.conversation.premiseCheck === true), lengthVariation: Boolean(config.conversation && config.conversation.lengthVariation === true), formalAddress: 'a reminder on every turn of a character whose description asks for «вы» (core/conversation/turnHints.js)' },
    persona: profile.llm.personaIsDefault ? 'default' : 'custom',
    runsPerScenario: runs,
    scenarios: scenarios.map((s) => ({ id: s.id, set: s.set, title: s.title, turns: s.turns, expect: (s.expect || []).map((e) => ({ turn: e.turn, id: e.id, title: e.title })) })),
    limits: LIMITS,
    thinkingControl,
    variants: {},
  };
  for (const v of variants) {
    report.variants[v.id] = { title: v.title, provenance: v.provenance || null, systemPromptChars: v.systemPrompt.trim().length, ...analyzeRecords(v.records, scenarios) };
  }
  const ids = Object.keys(report.variants);
  if (ids.length > 1 && report.variants.current) report.comparison = compareVariants(report.variants[ids[0]], report.variants.current);
  // "ok" = the evaluation itself worked (every request was answered). It is NOT a verdict on naturalness.
  report.ok = ids.length > 0 && Object.values(report.variants).every((v) => v.summary.replies > 0 && v.summary.answered === v.summary.replies);
  return report;
}

/** The closing lines: the counts per prompt, then the replies a reader should look at. */
function describeReport(report, say) {
  for (const [id, v] of Object.entries(report.variants)) {
    const s = v.summary;
    say(`${id}: ${s.answered}/${s.replies} answered; assistant-style findings in ${s.assistantLike} (managing/offering ${s.managementLike}, unrequested advice ${s.adviceLike})${Object.keys(s.byClass).length ? ` [${Object.entries(s.byClass).map(([c, n]) => `${c}×${n}`).join(', ')}]` : ''}; ` +
      `ends with a question ${s.endsWithQuestion}; mean ${s.words.mean} words; scenario protections ${s.expectationsMet}/${s.expectationsTotal}; system prompt ${v.systemPromptChars} chars / first-turn prompt ${s.promptTokensFirstTurn} tokens; median first answer text ${s.latencyMs.firstContentMedian} ms`);
  }
  const current = report.variants.current;
  if (current && current.detectedFailures.length) {
    say('');
    say('Assistant-style replies found with the current prompt:');
    for (const f of current.detectedFailures) say(`  ${f.scenario}.${f.run} [${f.classes.join(', ')}] > ${f.user}  < ${f.reply}`);
  }
  if (current && current.failedExpectations.length) {
    say('');
    say('Scenario protections NOT met with the current prompt:');
    for (const f of current.failedExpectations) say(`  ${f.scenario}.${f.run} [${f.expectation}] > ${f.user}  < ${f.reply}`);
  }
}

/**
 * The whole evaluation: connect, play the scenarios, build the report.
 *   baseline  {id, title, systemPrompt, provenance} — optional second prompt
 *             (the frozen VC-M0 prompt) for a controlled before/after: same
 *             model, settings, scenarios and code; it is played first.
 */
async function runConversationEval({ config, fetchImpl, runs = 3, say = console.log, scenarios = SCENARIOS, baseline = null }) {
  const provider = new LMStudioProvider({ getConfig: () => config.llm, fetchImpl });
  const profile = resolveLanguageProfile(config);

  say(`Endpoint: ${config.llm.endpoint}`);
  const conn = await provider.checkConnectivity();
  if (!conn.ok) {
    const report = buildReport({ config, model: null, runs, scenarios, variants: [] });
    report.error = `LM Studio could not be used: ${conn.error}`;
    say(report.error);
    return report;
  }
  say(`Model   : ${conn.selectedModel} (${conn.selectedReason})`);
  say(`Persona : ${profile.llm.personaIsDefault ? 'default' : 'custom'}; ${runs} run(s) per scenario; ${scenarios.reduce((n, s) => n + s.turns.length, 0) * runs} replies per prompt`);

  const variants = [{ id: 'current', title: CURRENT_TITLE, systemPrompt: profile.llm.systemPrompt }];
  if (baseline) variants.unshift({ id: baseline.id || 'vc_m0_baseline', title: baseline.title || 'frozen VC-M0 system prompt', systemPrompt: baseline.systemPrompt, provenance: baseline.provenance });
  for (const v of variants) {
    say('');
    say(`=== ${v.id}: ${v.title} ===`);
    // the current prompt gets the application's per-turn notes as configured; a frozen baseline prompt gets none
    const turnHint = v.id === 'current' ? (u) => turnHintFor({ userText: u, llm: profile.llm, conversation: config.conversation }) : null;
    v.records = await collectConversations({ provider, model: conn.selectedModel, systemPrompt: v.systemPrompt, historyTurns: config.session.historyTurns, scenarios, runs, say, turnHint });
  }
  const report = buildReport({ config, model: conn.selectedModel, runs, scenarios, variants, thinkingControl: provider.thinkingControl(conn.selectedModel) });
  say('');
  describeReport(report, say);
  return report;
}

module.exports = { SCENARIOS, CURRENT_TITLE, runConversationEval, collectConversations, analyzeRecords, buildReport, describeReport, compareVariants, spokenIssues, summarize };
