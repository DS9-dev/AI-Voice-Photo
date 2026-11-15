'use strict';
/**
 * The natural-conversation evaluation procedure (VC-M1.1) against the fake
 * LM Studio. Proves the procedure: the prompt path, the records, the counting.
 * Only conversation_eval.bat on the target PC says anything about the model.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeConfig } = require('../../core/config/configStore');
const { resolveLanguageProfile } = require('../../core/language/languages');
const { createFakeLmStudio } = require('../fixtures/fake_lmstudio');
const { SCENARIOS, runConversationEval, analyzeRecords, compareVariants, spokenIssues } = require('../../scripts/lib/conversationEval');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULTS = require(path.join(ROOT, 'config', 'default.json'));
const BASELINE = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'baselines', 'vc_m0_system_prompt.ru.txt'), 'utf8').replace(/\r\n/g, '\n');

/** A scripted "model": natural with the contract in the prompt, assistant-like without it. */
function scriptedReply(body) {
  const withContract = body.messages[0].content.includes('[КАК ВЕСТИ РАЗГОВОР]');
  const user = body.messages.filter((m) => m.role === 'user').pop().content;
  if (/Поможешь мне выбрать фильм/.test(user)) return { content: 'Конечно. Тебе сейчас хочется комедию или что-то серьёзное?' };
  if (/поговорим про фильмы/.test(user)) return { content: 'Давай. Я вчера как раз пересматривала старое кино.' };
  if (/видеокарту/.test(user)) return { content: 'О, какую взял?' };
  if (!withContract) return { content: 'Понятно. Если хочешь, можем поговорить о чём-нибудь другом. О чём ты хочешь поговорить?' };
  return { content: /^(Ладно, понятно\.|Ага\.|Ну да\.|Угу\.)$/.test(user) ? 'Угу.' : 'Да уж, бывает.' };
}

async function run(options = {}, lm = {}, llmPatch = {}) {
  const fake = createFakeLmStudio({ reply: scriptedReply, emulateQwenThinking: true, ...lm });
  const endpoint = await fake.start();
  const config = normalizeConfig({ llm: { endpoint, ...llmPatch }, ...(options.configPatch || {}) }, DEFAULTS);
  const said = [];
  try {
    const report = await runConversationEval({ config, runs: 2, say: (t) => said.push(t), ...options, configPatch: undefined });
    return { report, out: said.join('\n'), fake, config };
  } finally { await fake.stop(); }
}

test('the scenario set contains the eight required scenarios with the task\'s wording', () => {
  const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
  assert.deepEqual(SCENARIOS.filter((s) => s.set === 'required').map((s) => s.id), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  assert.deepEqual(byId.A.turns, ['Сегодня хорошая погода.']);
  assert.deepEqual(byId.B.turns, ['Я сегодня немного устал.']);
  assert.deepEqual(byId.C.turns, ['Мне этот фильм вообще не понравился.']);
  assert.deepEqual(byId.D.turns, ['Я вчера несколько часов возился с компьютером.']);
  assert.equal(byId.E.turns[byId.E.turns.length - 1], 'Ладно, понятно.');
  assert.equal(byId.F.turns[byId.F.turns.length - 1], 'Ладно, давай лучше поговорим про фильмы.');
  assert.deepEqual(byId.G.turns, ['Я сегодня купил себе новую видеокарту.']);
  assert.deepEqual(byId.H.turns, ['Поможешь мне выбрать фильм на вечер?']);
  // the two scenarios the contract must not break have explicit protections
  assert.deepEqual(byId.F.expect.map((e) => e.id), ['follows_topic_change']);
  assert.deepEqual(byId.H.expect.map((e) => e.id), ['engages_with_request', 'does_not_decline']);
  assert.deepEqual([...new Set(SCENARIOS.map((s) => s.set))], ['required', 'multi_turn', 'complaints', 'held_out']);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
});

test('the evaluation uses the application\'s prompt path and settings, unchanged', async () => {
  const { report, fake, config } = await run();
  const profile = resolveLanguageProfile(config);
  assert.equal(report.ok, true);
  assert.equal(report.model, 'qwen/qwen3.5-9b');
  const perRun = SCENARIOS.reduce((n, s) => n + s.turns.length, 0);
  assert.equal(fake.state.requests.length, perRun * 2);
  for (const body of fake.state.requests) {
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, profile.llm.systemPrompt, 'exactly the prompt a conversation gets');
    assert.equal(body.temperature, 0.7);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.top_k, 20);
    assert.equal(body.max_tokens, 300);
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.stream, true);
  }
  // a multi-turn scenario grows by one exchange per turn, like a session
  const m = SCENARIOS.find((s) => s.id === 'M');
  const mine = fake.state.requests.filter((b) => b.messages[1].content === m.turns[0]);
  assert.deepEqual(mine.slice(0, m.turns.length).map((b) => b.messages.length), m.turns.map((_, i) => 2 + 2 * i));
  assert.deepEqual(mine[2].messages.map((x) => x.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.equal(mine[2].messages[2].content, 'Да уж, бывает.', 'the model\'s own earlier reply is the history');
  assert.equal(report.settings.temperature, 0.7);
  assert.equal(report.persona, 'default');
  assert.deepEqual(report.thinkingControl, { strategy: 'effort', minimal: false });
});

test('every reply is recorded with input, output, detector result, length, question ending and latency', async () => {
  const { report } = await run();
  const v = report.variants.current;
  const perRun = SCENARIOS.reduce((n, s) => n + s.turns.length, 0);
  assert.equal(v.replies.length, perRun * 2);
  const g = v.replies.find((r) => r.scenario === 'G');
  assert.deepEqual(
    { scenario: g.scenario, set: g.set, run: g.run, turn: g.turn, user: g.user, reply: g.reply, outcome: g.outcome, detector: g.detector, shape: g.shape, spokenIssues: g.spokenIssues },
    { scenario: 'G', set: 'required', run: 1, turn: 0, user: 'Я сегодня купил себе новую видеокарту.', reply: 'О, какую взял?', outcome: 'ok',
      detector: { assistantLike: false, classes: [], groups: [], findings: [], solicited: [] },
      shape: { chars: 14, words: 3, sentences: 1, questions: 1, endsWithQuestion: true, choiceQuestion: false }, spokenIssues: [] },
  );
  for (const r of v.replies) {
    assert.ok(Number.isFinite(r.firstContentMs) && Number.isFinite(r.totalMs) && Number.isFinite(r.ttftMs));
    assert.ok(Number.isFinite(r.completionTokens));
  }
  assert.equal(v.summary.answered, v.summary.replies);
  assert.equal(v.summary.assistantLike, 0);
  assert.deepEqual(v.detectedFailures, []);
  assert.equal(v.summary.expectationsTotal, 6, 'F once and H twice, per run');
  assert.equal(v.summary.expectationsMet, 6);
  assert.equal(v.perScenario.G.endsWithQuestion, 2, 'a curiosity question is counted, not judged');
  assert.equal(v.perScenario.E.words.median, 2);
  assert.deepEqual(Object.keys(v.perSet), ['required', 'multi_turn', 'complaints', 'held_out']);
});

test('controlled before/after: the frozen VC-M0 prompt through the same procedure', async () => {
  const { report, fake, out } = await run({ baseline: { systemPrompt: BASELINE, provenance: 'commit c8e0bb2' } });
  assert.deepEqual(Object.keys(report.variants), ['vc_m0_baseline', 'current']);
  const before = report.variants.vc_m0_baseline;
  const after = report.variants.current;
  assert.equal(before.systemPromptChars, BASELINE.length);
  assert.ok(after.systemPromptChars > before.systemPromptChars);
  assert.equal(before.provenance, 'commit c8e0bb2');
  const perRun = SCENARIOS.reduce((n, s) => n + s.turns.length, 0);
  assert.equal(fake.state.requests.filter((b) => b.messages[0].content === BASELINE).length, perRun * 2, 'the baseline requests carry the frozen prompt and nothing else differs');
  // the scripted model manages the conversation without the contract
  assert.ok(before.summary.assistantLike > 0);
  assert.ok(before.summary.byClass.topic_change_offer > 0 && before.summary.byClass.asks_what_to_talk_about > 0);
  assert.equal(after.summary.assistantLike, 0);
  assert.equal(before.detectedFailures[0].classes.includes('topic_change_offer'), true);
  // requested behaviour is never a finding, in either variant
  for (const v of [before, after]) assert.equal(v.replies.filter((r) => ['F', 'H'].includes(r.scenario) && r.detector.assistantLike && r.turn === (r.scenario === 'F' ? 1 : 0)).length, 0);
  const row = (name) => report.comparison.find((c) => c.metric === name);
  assert.equal(row('replies with assistant-style findings').before, before.summary.assistantLike);
  assert.equal(row('replies with assistant-style findings').after, 0);
  assert.ok(row('mean words per reply').before > row('mean words per reply').after);
  assert.match(out, /=== vc_m0_baseline: /);
  assert.match(out, /=== current: /);
});

test('a contract that broke helping or topic changes would be reported, not hidden', () => {
  const records = [
    { scenario: 'H', run: 1, turn: 0, user: 'Поможешь мне выбрать фильм на вечер?', reply: 'Сейчас не могу выбирать за тебя, сам выбирай.', outcome: 'ok' },
    { scenario: 'H', run: 2, turn: 0, user: 'Поможешь мне выбрать фильм на вечер?', reply: 'Давай. Хочется комедию или что-то серьёзное?', outcome: 'ok' },
    { scenario: 'F', run: 1, turn: 0, user: 'Я вчера несколько часов возился с компьютером.', reply: 'Ого, долго.', outcome: 'ok' },
    { scenario: 'F', run: 1, turn: 1, user: 'Ладно, давай лучше поговорим про фильмы.', reply: 'А что там с компьютером в итоге?', outcome: 'ok' },
  ];
  const a = analyzeRecords(records);
  assert.deepEqual(a.failedExpectations.map((f) => [f.scenario, f.run, f.expectation]), [['H', 1, 'does_not_decline'], ['F', 1, 'follows_topic_change']]);
  assert.equal(a.summary.expectationsMet, 3);
  assert.equal(a.summary.expectationsTotal, 5);
  // replies observed from the real model that do take up the request without the word "film"
  const taken = analyzeRecords([
    { scenario: 'H', run: 1, turn: 0, user: 'Поможешь мне выбрать фильм на вечер?', reply: 'Хочешь что-то смешное или, может, поспокойнее? У меня есть пара вариантов, которые мне нравятся.', outcome: 'ok' },
    { scenario: 'H', run: 2, turn: 0, user: 'Поможешь мне выбрать фильм на вечер?', reply: 'Конечно, с удовольствием помогу. Что тебе больше нравится: что-то веселое и легкое или, может быть, что-то более глубокое и атмосферное?', outcome: 'ok' },
  ]);
  assert.deepEqual(taken.failedExpectations, []);
  // … while a deflection is not excused by a polite opening
  const deflected = analyzeRecords([{ scenario: 'H', run: 1, turn: 0, user: 'Поможешь мне выбрать фильм на вечер?', reply: 'Зачем тебе моя помощь, когда есть целый кинотеатр?', outcome: 'ok' }]);
  assert.deepEqual(deflected.failedExpectations.map((f) => f.expectation), ['does_not_decline']);
});

test('unanswered requests make the evaluation incomplete; an unreachable server is reported', async () => {
  const failing = await run({}, { reply: (body) => (/видеокарту/.test(body.messages[body.messages.length - 1].content) ? { status: 500 } : scriptedReply(body)) });
  assert.equal(failing.report.ok, false);
  const g = failing.report.variants.current.replies.filter((r) => r.scenario === 'G');
  assert.deepEqual(g.map((r) => r.outcome), ['api_failure', 'api_failure']);
  assert.equal(failing.report.variants.current.summary.answered, failing.report.variants.current.summary.replies - 2);

  const config = normalizeConfig({ llm: { endpoint: 'http://127.0.0.1:9/v1', connectTimeoutMs: 500 } }, DEFAULTS);
  const report = await runConversationEval({ config, runs: 1, say: () => {} });
  assert.equal(report.ok, false);
  assert.match(report.error, /LM Studio could not be used/);
  assert.deepEqual(report.variants, {});
});

test('spoken-output check and comparison helpers', () => {
  assert.deepEqual(spokenIssues('Да уж, бывает.'), []);
  assert.deepEqual(spokenIssues('Вот **список**:\n- раз\n- два'), ['markup_or_list']);
  assert.deepEqual(spokenIssues('Сюжет или acting?'), ['latin_script']);
  assert.deepEqual(spokenIssues('Минут 20, не больше.'), ['digits']);
  assert.deepEqual(spokenIssues('(улыбается) Привет.'), ['stage_direction']);
  assert.deepEqual(spokenIssues('Привет 🙂'), ['emoji']);
  const one = analyzeRecords([{ scenario: 'A', run: 1, turn: 0, user: 'Сегодня хорошая погода.', reply: 'Да, тепло. Могу помочь с чем-нибудь ещё?', outcome: 'ok', firstContentMs: 100, totalMs: 300, promptTokens: 500, completionTokens: 12 }]);
  const two = analyzeRecords([{ scenario: 'A', run: 1, turn: 0, user: 'Сегодня хорошая погода.', reply: 'Да, тепло.', outcome: 'ok', firstContentMs: 120, totalMs: 200, promptTokens: 900, completionTokens: 4 }]);
  const rows = Object.fromEntries(compareVariants(one, two).map((r) => [r.metric, [r.before, r.after]]));
  assert.deepEqual(rows['replies with assistant-style findings'], [1, 0]);
  assert.deepEqual(rows['… of them: managing the conversation or offering services'], [1, 0]);
  assert.deepEqual(rows['… of them: unrequested advice'], [0, 0]);
  const mixed = analyzeRecords([
    { scenario: 'B', run: 1, turn: 0, user: 'Я сегодня немного устал.', reply: 'Понимаю, бывает. Может, лучше чуть отдохнуть?', outcome: 'ok' },
    { scenario: 'B', run: 2, turn: 0, user: 'Я сегодня немного устал.', reply: 'Понимаю. Хочешь, я расскажу тебе что-нибудь? Или лучше отдохни.', outcome: 'ok' },
    { scenario: 'B', run: 3, turn: 0, user: 'Я сегодня немного устал.', reply: 'Ещё бы, такой день.', outcome: 'ok' },
  ]);
  assert.deepEqual([mixed.summary.assistantLike, mixed.summary.managementLike, mixed.summary.adviceLike], [2, 1, 2], 'a reply can be both');
  assert.deepEqual(rows['replies ending with a question (descriptive)'], [1, 0]);
  assert.deepEqual(rows['prompt tokens, first turn (system prompt + one line)'], [500, 900]);
  assert.deepEqual(rows['median time to first answer text, ms'], [100, 120]);
  assert.deepEqual(one.detectedFailures, [{ scenario: 'A', run: 1, turn: 0, user: 'Сегодня хорошая погода.', reply: 'Да, тепло. Могу помочь с чем-нибудь ещё?', classes: ['unrequested_help'] }]);
});
