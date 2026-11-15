'use strict';
/**
 * Per-turn notes (VC-M1.2, owner's decision of 2026-10-11): the light premise
 * check, the reply-length variation and the «вы» reminder. What is sent, when,
 * and what is never touched: the system prompt, the history, the transcript.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { premiseCheck, wantsFormalAddress, lengthWeights, pickLength, buildTurnHint, turnHintFor, withTurnHint } = require('../../core/conversation/turnHints');
const { LANGUAGES, resolveLanguageProfile } = require('../../core/language/languages');
const { normalizeConfig } = require('../../core/config/configStore');
const { makeOrchestrator, tick, playAll } = require('./helpers');
const { CURRENT_PROMPT } = require('../fixtures/acceptedPrompts');

const DEFAULTS = require(path.join('..', '..', 'config', 'default.json'));
const TEXTS = LANGUAGES.ru.llm.turnHints;
const THERAPIST = 'Ты — психотерапевт, сейчас идёт очная сессия, собеседник — твой клиент. Обращаешься к нему только на «вы». Говоришь спокойно, сдержанно и внимательно, без панибратства и шуток, не торопишь.';
const FRIEND = 'Ты — давняя близкая подруга собеседника, вы знакомы много лет. Вы на «ты». Говоришь просто, тепло и по-свойски, как говорят между собой близкие люди, можешь пошутить или поддеть. Сейчас вы вдвоём сидите у него дома.';
const NOTE_MARK = /\[(?:ПРОВЕРКА|ДЛИНА РЕПЛИКИ|ОБРАЩЕНИЕ)/;

test('premise check: the owner\'s lines and their kind are recognised', () => {
  const cases = {
    'Аккуратней, зачем себе стакан-то разбило?': ['premise', 'разбило'],
    'Зачем ты уронила стакан?': ['premise', 'уронила'],
    'Ты уже разбила чашку.': ['premise', 'разбила'],
    'Спасибо, что принесла плед.': ['premise', 'принесла'],
    'Куда ты поставила бутылку?': ['premise', 'поставила'],
    'Ты же только что налила чай.': ['premise', 'налила'],
    'Он такой тёплый, где ты его взяла?': ['premise', 'взяла'],
    'Не ври, я же видел, как ты его уронила.': ['premise', 'уронила'],
    'Вкусный. Ты туда мёд положила?': ['premise', 'положила'],
    'Возьми новый стакан.': ['handing', null],
    'Передай мне пульт.': ['handing', null],
    'Ну дай, он же рядом с тобой лежит.': ['handing', null],
  };
  for (const [line, [kind, word]] of Object.entries(cases)) assert.deepEqual(premiseCheck(line), { kind, word }, line);
});

test('premise check: requests, the user\'s own actions, imagination and memories are left alone', () => {
  for (const line of [
    'Завари мне чай.', 'Уже заварила?', 'Налей мне чаю.', 'Достань вино.', 'Готово?',
    'Я заварил чай.', 'Я разбил стакан.', 'Почему стакан разбился?', 'Ты вчера ходила в кино?', 'Что ты сегодня сделала?',
    'Давай помечтаем: что бы ты приготовила мне на завтрак?', 'Представь, что мы на кухне и ты наливаешь нам вино. Какое бы выбрала?',
    'Расскажи, как ты в детстве что-нибудь разбила.', 'Если бы ты налила вина, какое?', 'Ты бы налила мне вина?',
    'Дай подумать.', 'Как прошёл твой день?', 'Сегодня хорошая погода.', '',
  ]) assert.equal(premiseCheck(line), null, line);
});

test('the «вы» reminder is for a character whose description asks for «вы», only', () => {
  assert.equal(wantsFormalAddress(THERAPIST), true);
  assert.equal(wantsFormalAddress(FRIEND), false, '«Вы на «ты»» is not formal');
  assert.equal(wantsFormalAddress(LANGUAGES.ru.llm.defaultPersona), false);
  assert.equal(wantsFormalAddress('Говори с ним на вы.'), true);
  assert.equal(wantsFormalAddress(''), false);
});

test('length: weights follow the line and the character; a question is never answered «совсем коротко»', () => {
  assert.deepEqual(lengthWeights('Ага.'), { short: 0.7, medium: 0.3, long: 0 });
  assert.deepEqual(lengthWeights('Поможешь мне выбрать фильм на вечер?'), { short: 0, medium: 0.5, long: 0.5 });
  assert.deepEqual(lengthWeights('Как тебя зовут?'), { short: 0, medium: 0.5, long: 0.5 });
  assert.deepEqual(lengthWeights('Спина что-то разболелась.'), { short: 0, medium: 0.8, long: 0.2 });
  for (const line of ['У меня с утра голова болит.', 'Опять на работе завал, домой приду поздно.', 'Да не знаю, просто всё разом навалилось.', 'Что-то спать хочется.', 'Я сегодня на работе с начальником поругался.']) {
    assert.equal(lengthWeights(line).short, 0, `a complaint is never answered «совсем коротко»: ${line}`);
  }
  assert.deepEqual(lengthWeights('Я вчера несколько часов возился с компьютером.'), { short: 0.35, medium: 0.45, long: 0.2 });
  assert.deepEqual(lengthWeights('Я вчера несколько часов возился с компьютером.', { formal: true }), { short: 0.175, medium: 0.625, long: 0.2 });
  for (const line of ['Ага.', 'Как тебя зовут?', 'Мне скучно.', 'Сегодня хорошая погода.']) {
    for (const formal of [false, true]) {
      const w = lengthWeights(line, { formal });
      assert.ok(Math.abs(w.short + w.medium + w.long - 1) < 1e-9, line);
    }
  }
  assert.equal(pickLength('Сегодня хорошая погода.', 0), 'short');
  assert.equal(pickLength('Сегодня хорошая погода.', 0.5), 'medium');
  assert.equal(pickLength('Сегодня хорошая погода.', 0.99), 'long');
  for (let r = 0; r < 1; r += 0.05) assert.notEqual(pickLength('Расскажи что-нибудь интересное.', r), 'short');
  for (let r = 0; r < 1; r += 0.05) assert.notEqual(pickLength('Угу.', r), 'long');
});

test('the note for one turn: nothing when everything is off; each part when switched on', () => {
  const off = buildTurnHint({ userText: 'Зачем ты уронила стакан?', texts: TEXTS, settings: {}, random: 0 });
  assert.deepEqual(off, { note: null, applied: [], length: null });
  const premise = buildTurnHint({ userText: 'Зачем ты уронила стакан?', texts: TEXTS, settings: { premiseCheck: true } });
  assert.equal(premise.note, TEXTS.premise.split('{w}').join('уронила'));
  assert.deepEqual(premise.applied, ['premise:уронила']);
  const handing = buildTurnHint({ userText: 'Передай мне пульт.', texts: TEXTS, settings: { premiseCheck: true } });
  assert.equal(handing.note, TEXTS.handing);
  assert.equal(buildTurnHint({ userText: 'Как дела?', texts: TEXTS, settings: { premiseCheck: true } }).note, null, 'an ordinary line gets nothing');
  const short = buildTurnHint({ userText: 'Ага.', texts: TEXTS, settings: { lengthVariation: true }, random: 0 });
  assert.deepEqual([short.note, short.applied, short.length], [TEXTS.short, ['length:short'], 'short']);
  const medium = buildTurnHint({ userText: 'Ага.', texts: TEXTS, settings: { lengthVariation: true }, random: 0.9 });
  assert.deepEqual([medium.note, medium.applied], [null, ['length:medium']], 'a medium reply needs no note');
  const long = buildTurnHint({ userText: 'Расскажи что-нибудь интересное.', texts: TEXTS, settings: { lengthVariation: true }, random: 0.9 });
  assert.equal(long.note, TEXTS.long);
  const formal = buildTurnHint({ userText: 'Привет.', texts: TEXTS, settings: {}, formal: true });
  assert.deepEqual([formal.note, formal.applied], [TEXTS.formal, ['address:formal']]);
  const all = buildTurnHint({ userText: 'Спасибо, что принесла плед.', texts: TEXTS, settings: { premiseCheck: true, lengthVariation: true }, formal: true, random: 0.95 });
  assert.equal(all.note, [TEXTS.premise.split('{w}').join('принесла'), TEXTS.long, TEXTS.formal].join('\n'));
  // the texts: bracketed, short, no instruction to cut or stretch a reply
  for (const [k, v] of Object.entries(TEXTS)) {
    assert.match(v, /^\[[А-ЯЁ ]+: .+\]$/, k);
    assert.ok(v.length < 200, k);
  }
  assert.match(TEXTS.long, /без пустых слов/);
});

test('withTurnHint: without a note the user message is exactly the user\'s words', () => {
  assert.equal(withTurnHint('  Привет.  ', null), 'Привет.');
  assert.equal(withTurnHint('Привет.', '[ДЛИНА РЕПЛИКИ: x]'), 'Привет.\n\n[ДЛИНА РЕПЛИКИ: x]');
});

test('the application decides from the active profile and the two settings; both are off by default', () => {
  const cfg = normalizeConfig({}, DEFAULTS);
  assert.equal(cfg.conversation.premiseCheck, false);
  assert.equal(cfg.conversation.lengthVariation, false);
  assert.equal(DEFAULTS.conversation.premiseCheck, false);
  assert.equal(DEFAULTS.conversation.lengthVariation, false);
  for (const junk of ['true', 1, 'yes', null]) {
    const c = normalizeConfig({ conversation: { premiseCheck: junk, lengthVariation: junk } }, DEFAULTS);
    assert.deepEqual([c.conversation.premiseCheck, c.conversation.lengthVariation], [false, false], String(junk));
  }
  const llm = resolveLanguageProfile(cfg).llm;
  assert.equal(llm.turnHints, TEXTS);
  assert.equal(llm.systemPrompt, CURRENT_PROMPT, 'the system prompt is not touched by any of this');
  assert.deepEqual(turnHintFor({ userText: 'Зачем ты уронила стакан?', llm, conversation: cfg.conversation, random: 0 }), { note: null, applied: [], length: null });
  assert.deepEqual(turnHintFor({ userText: 'x', llm: { systemPrompt: 's' }, conversation: { premiseCheck: true } }), { note: null, applied: [], length: null }, 'no texts, no note');
  const on = normalizeConfig({ conversation: { premiseCheck: true, lengthVariation: true } }, DEFAULTS);
  assert.deepEqual(turnHintFor({ userText: 'Зачем ты уронила стакан?', llm: resolveLanguageProfile(on).llm, conversation: on.conversation, random: 0.95 }).applied, ['premise:уронила', 'length:long']);
});

const profileConfig = (description, patch = {}) => ({
  ...patch,
  characters: { activeId: 'p-0000000a', profiles: [{ id: 'p-0000000a', displayName: 'Сессия', characterName: 'Анна', description, voice: { provider: 'silero', id: 'baya' } }] },
});

test('orchestrator: settings off, built-in profile → the request is exactly today\'s', async () => {
  const { o, llm } = makeOrchestrator({}, { random: () => 0 });
  o.submitText('Зачем ты уронила стакан?', 'llm_only');
  assert.deepEqual(llm.last.req.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(llm.last.req.messages[1].content, 'Зачем ты уронила стакан?');
  assert.equal(llm.last.req.messages[0].content, CURRENT_PROMPT);
  llm.last.token('Я ничего не роняла.');
  llm.last.finish();
  await tick();
});

test('orchestrator: the note rides on the current request only — history, transcript and events keep the user\'s words', async () => {
  const { o, llm, tts, history, events } = makeOrchestrator({ conversation: { premiseCheck: true, lengthVariation: true } }, { random: () => 0.99 });
  o.submitText('Зачем ты уронила стакан?');
  const first = llm.last.req.messages;
  assert.equal(first.length, 2);
  assert.equal(first[1].content, `Зачем ты уронила стакан?\n\n${TEXTS.premise.split('{w}').join('уронила')}\n${TEXTS.long}`);
  assert.equal(first[0].content, CURRENT_PROMPT);
  llm.last.token('Я ничего не роняла, он сам упал.');
  llm.last.finish();
  await tick();
  playAll(tts, 't1');
  assert.deepEqual(history.getMessages(), [{ role: 'user', content: 'Зачем ты уронила стакан?' }, { role: 'assistant', content: 'Я ничего не роняла, он сам упал.' }]);
  o.submitText('Ладно.');
  const second = llm.last.req.messages;
  assert.equal(second[1].content, 'Зачем ты уронила стакан?', 'the earlier turn is sent as the user said it');
  assert.equal(NOTE_MARK.test(second.slice(0, -1).map((m) => m.content).join('\n')), false, 'no earlier note anywhere in the request');
  assert.equal(second[second.length - 1].content, 'Ладно.', 'a backchannel with a medium draw needs no note');
  llm.last.token('Угу.');
  llm.last.finish();
  await tick();
  playAll(tts, 't2');
  // what the user sees and what is stored: the user's words only
  const userMessages = events.messages.filter((m) => m.role === 'user').map((m) => m.text);
  assert.deepEqual(userMessages, ['Зачем ты уронила стакан?', 'Ладно.']);
  assert.equal(NOTE_MARK.test(JSON.stringify(events.messages)), false);
  assert.equal(NOTE_MARK.test(JSON.stringify(history.getMessages())), false);
  assert.equal(NOTE_MARK.test(JSON.stringify(events.turns)), false, 'the diagnostics record which note was used, not its text');
  assert.equal(events.turns[0].counters.turnHints, 'premise:уронила length:long');
  assert.equal(events.turns[1].counters.turnHints, 'length:medium');
});

test('orchestrator: the two switches are independent', async () => {
  const onlyLength = makeOrchestrator({ conversation: { lengthVariation: true } }, { random: () => 0 });
  onlyLength.o.submitText('Ты уже разбила чашку.', 'llm_only');
  assert.equal(onlyLength.llm.last.req.messages[1].content, `Ты уже разбила чашку.\n\n${TEXTS.short}`, 'length only: no premise note');
  const onlyPremise = makeOrchestrator({ conversation: { premiseCheck: true } }, { random: () => 0 });
  onlyPremise.o.submitText('Как дела?', 'llm_only');
  assert.equal(onlyPremise.llm.last.req.messages[1].content, 'Как дела?');
});

test('orchestrator: a character who asks for «вы» gets the reminder on every turn, settings off; the friend does not', async () => {
  const anna = makeOrchestrator(profileConfig(THERAPIST), { random: () => 0 });
  anna.o.submitText('Привет.', 'llm_only');
  assert.equal(anna.llm.last.req.messages[1].content, `Привет.\n\n${TEXTS.formal}`);
  assert.equal(anna.llm.last.req.messages[0].content.includes(TEXTS.formal), false, 'not in the system prompt');
  anna.llm.last.token('Здравствуйте.');
  anna.llm.last.finish();
  await tick();
  assert.deepEqual(anna.history.getMessages()[0], { role: 'user', content: 'Привет.' });
  const lena = makeOrchestrator(profileConfig(FRIEND), { random: () => 0 });
  lena.o.submitText('Привет.', 'llm_only');
  assert.equal(lena.llm.last.req.messages[1].content, 'Привет.');
});

test('the evaluation tools send exactly what the application sends: same note on the current message, history clean', async () => {
  const { collectConversations } = require('../../scripts/lib/conversationEval');
  const sent = [];
  const provider = { streamChat: async ({ messages }) => { sent.push(messages); return { text: 'Нет, я ничего не роняла.', outcome: 'ok', timings: {}, usage: {} }; } };
  const cfg = normalizeConfig({ conversation: { premiseCheck: true } }, DEFAULTS);
  const llm = resolveLanguageProfile(cfg).llm;
  const records = await collectConversations({
    provider, model: 'm', systemPrompt: llm.systemPrompt, historyTurns: 10, runs: 1,
    scenarios: [{ id: 'Q6', turns: ['Завари мне чай.', 'Аккуратней, зачем себе стакан-то разбило?'] }],
    turnHint: (u) => turnHintFor({ userText: u, llm, conversation: cfg.conversation }),
  });
  assert.equal(sent[0][1].content, 'Завари мне чай.');
  assert.equal(sent[1][3].content, `Аккуратней, зачем себе стакан-то разбило?\n\n${TEXTS.premise.split('{w}').join('разбило')}`);
  assert.equal(sent[1][1].content, 'Завари мне чай.');
  assert.deepEqual(records.map((r) => r.turnHints || null), [null, 'premise:разбило']);
  assert.deepEqual(records.map((r) => r.user), ['Завари мне чай.', 'Аккуратней, зачем себе стакан-то разбило?'], 'records keep the user\'s words');
  // without a decision passed in, nothing changes
  sent.length = 0;
  await collectConversations({ provider, model: 'm', systemPrompt: 's', historyTurns: 10, runs: 1, scenarios: [{ id: 'X', turns: ['Зачем ты уронила стакан?'] }] });
  assert.equal(sent[0][1].content, 'Зачем ты уронила стакан?');
});
