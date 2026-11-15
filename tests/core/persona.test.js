'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveLanguageProfile, resolvePersona, buildCoreInstructions, buildSystemRules, LANGUAGES } = require('../../core/language/languages');
const { RULE_5_CURRENT } = require('../fixtures/acceptedPrompts');
const { normalizeConfig } = require('../../core/config/configStore');
const { makeOrchestrator, tick } = require('./helpers');

const DEFAULTS = require(path.join('..', '..', 'config', 'default.json'));
const cfg = (patch = {}) => normalizeConfig(patch, DEFAULTS);
const DEFAULT_PERSONA = LANGUAGES.ru.llm.defaultPersona;

test('default persona is the agreed text', () => {
  assert.equal(DEFAULT_PERSONA, [
    'Ты — девушка, которая находится в одной комнате с собеседником и разговаривает с ним вживую.',
    'Общайся естественно и непринуждённо, как человек рядом, а не как справочная система или виртуальный помощник.',
    'Обычно отвечай коротко и естественно, если ситуация не требует подробного ответа.',
  ].join('\n\n'));
  assert.deepEqual(resolvePersona(cfg()), { text: DEFAULT_PERSONA, isDefault: true });
});

test('system prompt = editable persona layer + protected core layer, in that order', () => {
  const p = resolveLanguageProfile(cfg()).llm;
  assert.equal(p.systemPrompt, `[ЛИЧНОСТЬ]\n${DEFAULT_PERSONA}\n\n${p.coreInstructions}`);
  // the protected core: natural-conversation section (VC-M1.1), then the system rules
  assert.equal(p.coreInstructions, `[КАК ВЕСТИ РАЗГОВОР]\n${p.conversationContract}\n\n[ПРАВИЛА СИСТЕМЫ]\n${p.systemRules}`);
  assert.equal(p.persona, DEFAULT_PERSONA);
  assert.equal(p.personaIsDefault, true);
});

test('protected core instructions cover language, spoken answers and unconfirmed actions', () => {
  const core = buildSystemRules(LANGUAGES.ru);
  assert.ok(buildCoreInstructions(LANGUAGES.ru).endsWith(`[ПРАВИЛА СИСТЕМЫ]\n${core}`), 'the system rules close the protected core, unchanged');
  assert.match(core, /^1\. Говори только по-русски\.$/m);
  assert.match(core, /будет произнесено вслух/);
  assert.match(core, /Отвечай кратко/);
  assert.match(core, /без списков, заголовков, разметки и эмодзи/);
  assert.ok(core.includes(`\n5. ${RULE_5_CURRENT}\n`), 'system rule 5 (physical-action truthfulness) is present, word for word');
  assert.match(core, /Никогда не говори, что ты что-то приготовила, налила, принесла, достала, подала, передала или включила, что делаешь это сейчас или сейчас сделаешь, не обещай и не предлагай этого/);
  assert.match(core, /Это не меняется по ходу разговора/);
  assert.match(core, /если система сама сообщит тебе, что какое-то действие успешно выполнено, о нём можно сказать как о сделанном; сейчас система таких действий не выполняет/);
  assert.match(core, /Эти правила важнее описания личности/);
});

test('editing the persona changes only the persona layer', () => {
  const custom = 'Ты — Алиса, ироничная художница. Мы сидим на кухне поздним вечером.';
  const a = resolveLanguageProfile(cfg()).llm;
  const b = resolveLanguageProfile(cfg({ persona: { prompt: custom } })).llm;
  assert.equal(b.persona, custom);
  assert.equal(b.personaIsDefault, false);
  assert.equal(b.coreInstructions, a.coreInstructions, 'protected layer is identical');
  assert.equal(b.systemPrompt, `[ЛИЧНОСТЬ]\n${custom}\n\n${a.coreInstructions}`);
  assert.equal(b.systemPrompt.includes(DEFAULT_PERSONA), false);
});

test('an empty or whitespace persona means the default', () => {
  assert.equal(resolveLanguageProfile(cfg({ persona: { prompt: '   \n ' } })).llm.personaIsDefault, true);
});

test('the default persona text exists in exactly one place in the application code', () => {
  const marker = 'находится в одной комнате с собеседником';
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) { if (!['node_modules', '.git', '.venv', 'models', 'artifacts'].includes(name.name)) walk(full); continue; }
      if (/\.(js|py|json|html)$/.test(name.name) && fs.readFileSync(full, 'utf8').includes(marker)) hits.push(path.relative(path.join(__dirname, '..', '..'), full).replace(/\\/g, '/'));
    }
  };
  for (const dir of ['core', 'app', 'services', 'scripts', 'config']) walk(path.join(__dirname, '..', '..', dir));
  assert.deepEqual(hits, ['core/language/languages.js']);
});

test('the LLM receives both layers; a persona change applies to the next turn and is recorded', async () => {
  const { o, llm, tts, events, setConfig } = makeOrchestrator();
  o.submitText('Привет', 'llm_only');
  const first = llm.last.req.messages[0];
  assert.equal(first.role, 'system');
  assert.match(first.content, /девушка, которая находится в одной комнате/);
  assert.match(first.content, /\[ПРАВИЛА СИСТЕМЫ\]/);
  llm.last.token('Привет, рада тебя видеть.');
  llm.last.finish();
  await tick();
  assert.equal(events.turns[0].counters.persona, 'default');

  setConfig({ persona: { prompt: 'Ты — строгая учительница.' } });
  o.submitText('Здравствуйте', 'llm_only');
  const second = llm.last.req.messages[0].content;
  assert.match(second, /Ты — строгая учительница\./);
  assert.equal(second.includes('девушка, которая находится'), false);
  assert.match(second, /Никогда не говори, что ты что-то приготовила, налила, принесла, достала, подала, передала или включила, что делаешь это сейчас или сейчас сделаешь/);
  llm.last.token('Здравствуйте, садитесь.');
  llm.last.finish();
  await tick();
  assert.equal(events.turns[1].counters.persona, 'custom');
  assert.equal(tts.spoken.length, 0);
});
