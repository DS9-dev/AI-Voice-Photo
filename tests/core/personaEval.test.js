'use strict';
/**
 * The persona switching evaluation (VC-M1.2) itself: that it uses the
 * application's prompt path, that its temporary characters never touch the
 * user's configuration, and that its verdict can fail. Runs against the FAKE
 * LM Studio server; what the real model does is recorded by
 * scripts/persona_eval.js, not here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PERSONAS, SCENARIOS, addressForm, namesIn, traitsIn, promptIsolation, personaVariants, buildPersonaReport, describePersonaReport, runPersonaEval } = require('../../scripts/lib/personaEval');
const { normalizeConfig, ConfigStore } = require('../../core/config/configStore');
const { buildCoreInstructions, LANGUAGES, resolveLanguageProfile } = require('../../core/language/languages');
const { createFakeLmStudio } = require('../fixtures/fake_lmstudio');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULTS = require(path.join(ROOT, 'config', 'default.json'));
const CORE = buildCoreInstructions(LANGUAGES.ru);
const { VC_M1_1_PROMPT, CURRENT_PROMPT, withCurrentCore } = require('../fixtures/acceptedPrompts');
const cfg = (patch = {}) => normalizeConfig(patch, DEFAULTS);
const REPLIES_PER_CHARACTER = SCENARIOS.reduce((n, s) => n + s.turns.length, 0);

/** A stand-in model that answers the way the system prompt describes the character. */
function obedient(body) {
  const system = body.messages[0].content;
  const user = body.messages[body.messages.length - 1].content;
  const name = (/Тебя зовут ([А-Яа-яё]+)\./.exec(system) || [])[1];
  const formal = /только на «вы»/.test(system);
  if (/Как тебя зовут/.test(user)) return { content: name ? `Меня зовут ${name}.` : 'А как бы ты хотел меня называть?' };
  return { content: formal ? 'Понимаю вас. Что вы сейчас чувствуете?' : 'Ох, понимаю тебя. Что у тебя случилось?' };
}

async function evaluate(reply, { runs = 1, config = cfg() } = {}) {
  const fake = createFakeLmStudio({ reply });
  const endpoint = await fake.start();
  try {
    const said = [];
    const report = await runPersonaEval({ config: { ...config, llm: { ...config.llm, endpoint } }, defaults: DEFAULTS, runs, say: (t) => said.push(t) });
    return { report, fake, said };
  } finally { await fake.stop(); }
}

test('reading a reply: the form of address and the characters\' names', () => {
  assert.equal(addressForm('Привет. Ты сегодня какой-то уставший.').form, 'informal');
  assert.equal(addressForm('Расскажешь, что случилось?').form, 'informal');
  assert.equal(addressForm('Здравствуйте. Расскажите, что вас беспокоит.').form, 'formal');
  assert.equal(addressForm('Как вы себя чувствуете?').form, 'formal');
  assert.equal(addressForm('Ты садись, а вы пока расскажите.').form, 'mixed');
  for (const neutral of ['Привет.', 'Лишь бы не было дождя.', 'Тишь да гладь.', 'Понимаю. Тяжёлый день.', 'Это о свете в интернете и о билете.']) assert.equal(addressForm(neutral).form, 'none', neutral);
  assert.deepEqual(namesIn('Меня зовут Лена.'), ['Лена']);
  assert.deepEqual(namesIn('Я — Анна.'), ['Анна']);
  assert.deepEqual(namesIn('Зови меня Леночкой, а Анну не слушай.'), ['Лена', 'Анна']);
  assert.deepEqual(namesIn('Елена смотрела плёнку про аннулирование.'), [], 'a name inside another word is not a mention');
  // characteristic markers of a character: her role, her relationship to the user
  assert.deepEqual(traitsIn('Давайте вернёмся к тому, о чём мы говорили на прошлой сессии.'), [], 'a session not named as ours/this is no marker');
  assert.deepEqual(traitsIn('На нашей сессии это важно.'), ['session_therapist']);
  assert.deepEqual(traitsIn('Как ваш психотерапевт, я слышу вас.'), ['session_therapist']);
  assert.deepEqual(traitsIn('Мы же с тобой знакомы сто лет.'), ['close_friend']);
  assert.deepEqual(traitsIn('Я твоя давняя подруга, не забывай.'), ['close_friend']);
  for (const neutral of ['Привет. Ты сегодня какой-то уставший.', 'Понимаю вас. Что вы сейчас чувствуете?', 'Подруга звонила вчера.', 'Сеанс в кино начался поздно.']) assert.deepEqual(traitsIn(neutral), [], neutral);
});

test('the evaluation characters are made through the application\'s profile operations and prompt builder', () => {
  const base = cfg();
  const before = JSON.stringify(base);
  const variants = personaVariants(base, DEFAULTS);
  assert.equal(JSON.stringify(base), before, 'the configuration passed in is not changed');
  assert.deepEqual(variants.map((v) => v.id), ['default', 'close_friend', 'session_therapist']);
  assert.ok(PERSONAS.filter((p) => p.profile).length >= 2, 'at least two different characters besides the control');

  const [control, friend, session] = variants;
  assert.equal(control.systemPrompt, CURRENT_PROMPT, 'the control is the prompt accepted in VC-M1.1, system rule 5 as corrected in VC-M1.2');
  assert.equal(control.systemPrompt, withCurrentCore(VC_M1_1_PROMPT));
  assert.equal(friend.systemPrompt, `[ЛИЧНОСТЬ]\nТебя зовут Лена.\n\n${PERSONAS[1].profile.description}\n\n${CORE}`);
  assert.equal(session.systemPrompt, `[ЛИЧНОСТЬ]\nТебя зовут Анна.\n\n${PERSONAS[2].profile.description}\n\n${CORE}`);
  for (const v of variants) {
    assert.equal(v.systemPrompt, resolveLanguageProfile(v.config).llm.systemPrompt, 'exactly what the application would send with this profile active');
    assert.equal(v.coreInstructions, CORE);
  }
  // each character is the ACTIVE profile of its configuration, with its own voice
  assert.deepEqual([friend.character.characterName, friend.character.voice, friend.character.builtIn], ['Лена', 'kseniya', false]);
  assert.deepEqual([session.character.characterName, session.character.voice], ['Анна', 'baya']);
  assert.equal(friend.config.characters.activeId, friend.config.characters.profiles[1].id);
  assert.deepEqual(control.config.characters, { activeId: 'default', profiles: [{ id: 'default', displayName: '', characterName: '', description: '', voice: { provider: 'silero', id: '' } }] });
  // neutral user lines: nothing in them names a role or asks for a style
  const lines = SCENARIOS.flatMap((s) => s.turns).join(' ');
  for (const word of ['подруг', 'терап', 'психо', 'сесси', 'на «вы»', 'на «ты»', 'Лена', 'Анна']) assert.equal(lines.includes(word), false, word);
});

test('a persona the user is editing at home does not take part, and config/user.json is never written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vvc-peval-'));
  const userPath = path.join(dir, 'user.json');
  const mine = { characters: { activeId: 'mine', profiles: [{ id: 'mine', displayName: 'Моя', characterName: 'Вера', description: 'Ты — Вера.', voice: { provider: 'silero', id: 'aidar' } }] }, session: { historyTurns: 4 } };
  fs.writeFileSync(userPath, JSON.stringify(mine));
  const store = new ConfigStore({ defaultPath: path.join(ROOT, 'config', 'default.json'), userPath });
  const { report } = await evaluate(obedient, { config: store.get() });
  assert.equal(report.ok, true);
  assert.equal(fs.readFileSync(userPath, 'utf8'), JSON.stringify(mine), 'the user\'s file is untouched');
  assert.equal(JSON.stringify(report).includes('Вера'), false);
  assert.equal(report.settings.historyTurns, 4, 'the user\'s other settings are the ones evaluated');
  assert.equal(report.variants.default.systemPromptSha256, require('node:crypto').createHash('sha256').update(CURRENT_PROMPT, 'utf8').digest('hex'));
});

test('a model that follows the active profile passes: name, address, nothing of another character; every conversation starts empty', async () => {
  const { report, fake, said } = await evaluate(obedient, { runs: 2 });
  assert.equal(report.ok, true);
  assert.equal(report.kind, 'REAL_MODEL_PERSONA_EVALUATION');
  assert.deepEqual(report.verdict, { everyRequestAnswered: true, nameFollowsProfile: true, addressFollowsProfile: true, noOtherCharactersName: true, noOtherCharactersTraits: true, profilesIsolatedInPrompts: true, protectedCoreIdentical: true, charactersCompared: 2, status: 'PASS' });
  assert.deepEqual(report.isolation.prompts, { isolated: true, profilesChecked: ['default', 'close_friend', 'session_therapist'], leaks: [] });
  assert.equal(fake.state.requests.length, 3 * 2 * REPLIES_PER_CHARACTER);
  for (const id of ['default', 'close_friend', 'session_therapist']) assert.equal(report.variants[id].summary.replies, 2 * REPLIES_PER_CHARACTER, id);
  assert.deepEqual(report.variants.close_friend.summary.nameQuestion.saysOwnName, 2);
  assert.equal(report.variants.close_friend.verdict.addressFollowsProfile, true);
  assert.equal(report.variants.session_therapist.summary.address.informal, 0);
  assert.equal(report.variants.default.verdict.nameFollowsProfile, null, 'the control has no name to check');
  assert.equal(report.protectedCore.identicalForEveryCharacter, true);

  // through the application path: the system prompt of the active profile, then only this conversation
  const prompts = new Set(fake.state.requests.map((r) => r.messages[0].content));
  assert.equal(prompts.size, 3);
  for (const request of fake.state.requests) {
    const system = request.messages[0].content;
    assert.ok(system.endsWith(`\n\n${CORE}`), 'the protected core closes every prompt');
    const others = ['Лена', 'Анна'].filter((n) => !system.includes(`Тебя зовут ${n}.`));
    for (const n of others) assert.equal(JSON.stringify(request.messages).includes(n), false, `${n} in a request of another character`);
    assert.equal(request.messages.filter((m) => m.role === 'system').length, 1);
  }
  const firstTurns = fake.state.requests.filter((r) => r.messages.length === 2).length;
  assert.equal(firstTurns, 3 * 2 * SCENARIOS.length, 'every conversation starts with an empty history');
  assert.ok(said.some((l) => /REAL_PERSONA_SWITCHING_EVALUATION: PASS/.test(l)));
});

test('the verdict fails when the model ignores the profile', async () => {
  // one voice for everybody: informal, and it calls itself «Лена» whoever is active
  const stuck = await evaluate((body) => (/Как тебя зовут/.test(body.messages[body.messages.length - 1].content) ? { content: 'Меня зовут Лена.' } : { content: 'Ох, понимаю тебя. Что у тебя случилось?' }));
  assert.equal(stuck.report.ok, true, 'the evaluation ran');
  assert.equal(stuck.report.verdict.status, 'FAIL');
  assert.equal(stuck.report.verdict.nameFollowsProfile, false);
  assert.equal(stuck.report.verdict.addressFollowsProfile, false);
  assert.equal(stuck.report.verdict.noOtherCharactersName, false);
  assert.equal(stuck.report.variants.session_therapist.verdict.ok, false);
  assert.equal(stuck.report.variants.session_therapist.summary.nameQuestion.saysAnotherCharactersName, 1);
  assert.equal(stuck.report.variants.close_friend.verdict.ok, true);
  // gate 11: the control has no name of its own, so the name it gives is recorded, not judged
  assert.equal(stuck.report.variants.default.verdict.noOtherCharactersName, null);
  assert.equal(stuck.report.variants.default.verdict.ok, true);
  assert.deepEqual(stuck.report.isolation.inventedNamesInProfilesWithoutName.default.map((x) => x.names), [['Лена']]);

  // right names, wrong address for the formal character
  const casual = await evaluate((body) => {
    const o = obedient(body);
    return /Как тебя зовут/.test(body.messages[body.messages.length - 1].content) ? o : { content: 'Ох, понимаю тебя. Что у тебя случилось?' };
  });
  assert.deepEqual([casual.report.verdict.nameFollowsProfile, casual.report.verdict.addressFollowsProfile, casual.report.verdict.status], [true, false, 'FAIL']);

  // replies that address nobody cannot show that the address follows the profile
  const mute = await evaluate((body) => (/Как тебя зовут/.test(body.messages[body.messages.length - 1].content) ? obedient(body) : { content: 'Понятно. Тяжёлый день.' }));
  assert.equal(mute.report.verdict.addressFollowsProfile, false);
  assert.equal(mute.report.verdict.status, 'FAIL');
});

test('gate 11: a name invented by a profile without a name is an observation; a named profile using another name fails', async () => {
  // the built-in profile, asked for its name, happens to say «Анна»; the named characters answer correctly
  const invents = await evaluate((body) => {
    const system = body.messages[0].content;
    if (/Как тебя зовут/.test(body.messages[body.messages.length - 1].content) && !/Тебя зовут/.test(system)) return { content: 'Зови меня Анной.' };
    return obedient(body);
  });
  assert.equal(invents.report.verdict.status, 'PASS', 'an invented name in a profile without a name does not fail by itself');
  assert.equal(invents.report.verdict.noOtherCharactersName, true);
  assert.equal(invents.report.variants.default.verdict.noOtherCharactersName, null);
  assert.equal(invents.report.variants.default.summary.repliesWithAnotherCharactersName, 1, 'still counted');
  assert.deepEqual(invents.report.isolation.inventedNamesInProfilesWithoutName.default, [{ key: 'P2.1.0', names: ['Анна'], reply: 'Зови меня Анной.' }]);
  assert.ok(invents.said.some((l) => /default: .*another character's name in 1 \(no name of its own: observation\)/.test(l)));

  // the friend, who has a name of her own, calls herself «Анна» once in another scenario: a real failure
  const swapped = await evaluate((body) => {
    const system = body.messages[0].content;
    if (/Тебя зовут Лена/.test(system) && /сериал/.test(body.messages[body.messages.length - 1].content)) return { content: 'Ну наконец-то, Анна тобой гордится.' };
    return obedient(body);
  });
  assert.equal(swapped.report.verdict.noOtherCharactersName, false);
  assert.equal(swapped.report.variants.close_friend.verdict.ok, false);
  assert.equal(swapped.report.verdict.status, 'FAIL');
});

test('profile isolation is checked independently of names: another character\'s traits in a reply, another profile in a prompt', async () => {
  // the built-in profile talks like the therapist: her instructions reached it, whatever its name
  const leaky = await evaluate((body) => {
    const system = body.messages[0].content;
    if (!/Тебя зовут/.test(system) && /вымотался/.test(body.messages[body.messages.length - 1].content)) return { content: 'Понимаю. На нашей сессии давайте побудем с этим.' };
    return obedient(body);
  });
  assert.equal(leaky.report.variants.default.verdict.noOtherCharactersTraits, false);
  assert.equal(leaky.report.variants.default.verdict.ok, false);
  assert.equal(leaky.report.verdict.noOtherCharactersTraits, false);
  assert.equal(leaky.report.verdict.status, 'FAIL', 'an unnamed profile is not exempt from the isolation check');
  assert.deepEqual(leaky.report.variants.default.summary.anotherCharactersTraits.map((x) => x.of), [['session_therapist']]);
  // the character's own markers are hers: the therapist speaking of «our session» is no leak
  const own = await evaluate((body) => (/Тебя зовут Анна/.test(body.messages[0].content) && !/Как тебя зовут/.test(body.messages[body.messages.length - 1].content) ? { content: 'Понимаю вас. На нашей сессии вы можете не торопиться.' } : obedient(body)));
  assert.equal(own.report.verdict.noOtherCharactersTraits, true);
  assert.equal(own.report.verdict.status, 'PASS');

  // in the prompts: the application's profiles are isolated; a prompt carrying another profile is found
  const variants = personaVariants(cfg(), DEFAULTS);
  assert.deepEqual(promptIsolation(variants), { isolated: true, profilesChecked: ['default', 'close_friend', 'session_therapist'], leaks: [] });
  const tampered = variants.map((v) => (v.id === 'close_friend' ? { ...v, systemPrompt: v.systemPrompt.replace('Сейчас вы вдвоём', `${PERSONAS[2].profile.description} Сейчас вы вдвоём`) } : v));
  assert.deepEqual(promptIsolation(tampered).leaks, [{ profile: 'close_friend', contains: 'description', of: 'session_therapist' }]);
  const named = variants.map((v) => (v.id === 'default' ? { ...v, systemPrompt: v.systemPrompt.replace('[ЛИЧНОСТЬ]\n', '[ЛИЧНОСТЬ]\nТебя зовут Лена.\n') } : v));
  assert.deepEqual(promptIsolation(named).leaks, [{ profile: 'default', contains: 'name', of: 'close_friend' }]);
  const report = buildPersonaReport({ config: cfg(), model: 'm', runs: 1, variants: tampered.map((v) => ({ ...v, records: [] })), generatedAt: 'T' });
  assert.equal(report.verdict.profilesIsolatedInPrompts, false);
  assert.equal(report.verdict.status, 'FAIL');
});

test('unanswered requests make the evaluation incomplete, not passed', async () => {
  const { report, said } = await evaluate((body) => (body.messages[0].content.includes('Анна') ? { status: 500 } : obedient(body)));
  assert.equal(report.ok, false);
  assert.equal(report.verdict.everyRequestAnswered, false);
  assert.equal(report.verdict.status, 'FAIL');
  assert.ok(said.some((l) => /REAL_PERSONA_SWITCHING_EVALUATION: INCOMPLETE/.test(l)));

  const fake = createFakeLmStudio({});
  const endpoint = await fake.start();
  await fake.stop();
  const offline = await runPersonaEval({ config: { ...cfg(), llm: { ...cfg().llm, endpoint } }, defaults: DEFAULTS, runs: 1, say: () => {} });
  assert.equal(offline.ok, false);
  assert.match(offline.error, /LM Studio could not be used/);
  assert.equal(offline.verdict.status, 'FAIL');
});

test('the report can be rebuilt from raw records; the detector numbers are observations outside the verdict', () => {
  const variants = personaVariants(cfg(), DEFAULTS).map((v) => ({
    ...v,
    records: SCENARIOS.flatMap((sc) => sc.turns.map((user, turn) => ({
      scenario: sc.id, run: 1, turn, user, outcome: 'ok', error: null, ttftMs: 100, firstContentMs: 100, totalMs: 300, promptTokens: 900, completionTokens: 12,
      reply: sc.probe === 'name' ? (v.expect.name ? `Меня зовут ${v.expect.name}.` : 'Просто зови меня как хочешь.')
        : v.expect.address === 'formal' ? 'Может, вам стоит отдохнуть? Хотите, я расскажу, как расслабиться?' : 'Ох, понимаю тебя.',
    }))),
  }));
  const report = buildPersonaReport({ config: cfg(), model: 'm', runs: 1, variants, generatedAt: 'T' });
  assert.equal(report.verdict.status, 'PASS', 'unrequested advice and offers do not decide the verdict');
  assert.ok(report.variants.session_therapist.summary.assistantLike > 0, 'they are still counted and shown');
  assert.ok(report.variants.session_therapist.detectedFailures.length > 0);
  assert.match(report.limits.join(' '), /not part of the verdict/);
  assert.equal(report.generatedAt, 'T');
  const lines = [];
  describePersonaReport(report, (l) => lines.push(l));
  assert.match(lines.join('\n'), /session_therapist: .*address informal 0 \/ formal \d+ .*expected formal: yes/);
  // one character alone proves no switching
  const single = buildPersonaReport({ config: cfg(), model: 'm', runs: 1, variants: variants.slice(0, 2), generatedAt: 'T' });
  assert.equal(single.verdict.charactersCompared, 1);
  assert.equal(single.verdict.status, 'FAIL');
});
