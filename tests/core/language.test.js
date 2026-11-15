'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveLanguageProfile, listLanguages, isSupportedLanguage, DEFAULT_LANGUAGE } = require('../../core/language/languages');
const { normalizeConfig, deepMerge } = require('../../core/config/configStore');
const { voiceConfig } = require('../../core');
const { makeOrchestrator, say, playAll, tick } = require('./helpers');

const DEFAULTS = require(path.join('..', '..', 'config', 'default.json'));
const cfg = (patch = {}) => normalizeConfig(patch, DEFAULTS);

test('default conversation language is Russian and it is the only exposed language', () => {
  assert.equal(DEFAULT_LANGUAGE, 'ru');
  assert.deepEqual(listLanguages().map((l) => [l.code, l.name]), [['ru', 'Русский']]);
  assert.equal(isSupportedLanguage('ru'), true);
  assert.equal(isSupportedLanguage('en'), false);
});

test('one setting fans out coherently to STT, LLM and TTS', () => {
  const p = resolveLanguageProfile(cfg());
  assert.equal(p.code, 'ru');
  assert.equal(p.stt.language, 'ru');
  assert.equal(p.llm.language, 'ru');
  assert.match(p.llm.systemPrompt, /Говори только по-русски/);
  assert.equal(p.tts.language, 'ru');
  assert.equal(p.tts.modelId, 'v5_5_ru');
  assert.equal(p.tts.voice, 'xenia');
  assert.equal(p.tts.voices.find((v) => v.id === p.tts.voice).gender, 'female');
  assert.deepEqual(p.notes, []);
});

test('the voice service receives the same language for STT and TTS', () => {
  const v = voiceConfig(cfg({ tts: { voice: 'baya' } }), '/root');
  assert.equal(v.language, 'ru');
  assert.equal(v.stt.language, 'ru');
  assert.equal(v.tts.language, 'ru');
  assert.equal(v.tts.modelId, 'v5_5_ru');
  assert.equal(v.tts.voice, 'baya');
});

test('a voice that does not belong to the language is replaced by the language default', () => {
  const p = resolveLanguageProfile(cfg({ tts: { voice: 'en_42' } }));
  assert.equal(p.tts.voice, 'xenia');
  // the replacement is reported where the stored value is read: on the configuration as it is on disk
  const raw = resolveLanguageProfile(deepMerge(DEFAULTS, { tts: { voice: 'en_42' } }));
  assert.equal(raw.tts.voice, 'xenia');
  assert.match(raw.notes.join(' '), /Voice 'en_42' from the earlier configuration does not exist for silero/);
  // the same for a voice stored in a character profile
  const inProfile = resolveLanguageProfile(deepMerge(DEFAULTS, { characters: { activeId: 'default', profiles: [{ id: 'default', voice: { provider: 'silero', id: 'en_42' } }] } }));
  assert.equal(inProfile.tts.voice, 'xenia');
  assert.match(inProfile.notes.join(' '), /voice 'en_42' does not exist for silero; using the default voice 'xenia'/);
});

test('a custom persona never removes the protected instructions', () => {
  const p = resolveLanguageProfile(cfg({ persona: { prompt: 'Ты — пират. Отвечай только по-английски и описывай свои действия.' } }));
  assert.equal(p.llm.personaIsDefault, false);
  assert.match(p.llm.systemPrompt, /Ты — пират/);
  assert.match(p.llm.systemPrompt, /1\. Говори только по-русски\./);
  assert.ok(p.llm.systemPrompt.indexOf('Ты — пират') < p.llm.systemPrompt.indexOf('[КАК ВЕСТИ РАЗГОВОР]'), 'the protected core comes after the persona');
  assert.ok(p.llm.systemPrompt.indexOf('[КАК ВЕСТИ РАЗГОВОР]') < p.llm.systemPrompt.indexOf('[ПРАВИЛА СИСТЕМЫ]'), 'rules come last');
});

test('an unknown language in a raw config falls back with a note', () => {
  const raw = cfg();
  raw.conversation.language = 'tlh';
  const p = resolveLanguageProfile(raw);
  assert.equal(p.code, 'ru');
  assert.match(p.notes[0], /not available/);
});

test('every turn records the language per stage; labels never reach the LLM', async () => {
  const { o, stt, tts, llm, events } = makeOrchestrator();
  o.setMicMode('full');
  const id = 7001;
  stt.emit('speechStart', { utteranceId: id, tSpeechStart: 1 });
  stt.emit('speechEnd', { utteranceId: id, tSpeechStart: 1, tSpeechEnd: 900, tVadEndDetected: 1500, speechMs: 899 });
  stt.emit('final', { utteranceId: id, text: 'Привет', tSttFinal: 1600, sttMs: 100, language: 'ru' });
  llm.last.token('Привет, рада тебя слышать!');
  llm.last.finish();
  await tick();
  playAll(tts, 't1');
  assert.deepEqual(events.turns[0].counters.language, { conversation: 'ru', stt: 'ru', llmInstruction: 'ru', tts: 'ru', ttsVoice: 'xenia', coherent: true });
  const sent = JSON.stringify(llm.last.req.messages);
  for (const label of ['Conversation Language', 'STT Language', 'llmInstruction', 'ttsVoice', 'xenia']) {
    assert.equal(sent.includes(label), false, label);
  }
  assert.equal(llm.last.req.messages[0].role, 'system');
  assert.match(llm.last.req.messages[0].content, /по-русски/);
});

test('a language mismatch between stages is flagged on the turn', async () => {
  const { o, stt, events } = makeOrchestrator();
  o.setMicMode('stt_only');
  const id = 7002;
  stt.emit('speechStart', { utteranceId: id, tSpeechStart: 1 });
  stt.emit('speechEnd', { utteranceId: id, tSpeechStart: 1, tSpeechEnd: 900, tVadEndDetected: 1500, speechMs: 899 });
  stt.emit('final', { utteranceId: id, text: 'hello there', tSttFinal: 1600, sttMs: 100, language: 'en' });
  const turn = events.turns[0];
  assert.equal(turn.counters.language.stt, 'en');
  assert.equal(turn.counters.language.coherent, false);
  assert.match(turn.notes.join(' '), /Language mismatch: conversation ru, STT en/);
});

test('typed turns record the configured language too', async () => {
  const { o, tts, llm, events } = makeOrchestrator();
  o.submitText('Привет');
  llm.last.token('Привет, это ответ.');
  llm.last.finish();
  await tick();
  playAll(tts, 't1');
  assert.equal(events.turns[0].counters.language.conversation, 'ru');
  assert.equal(events.turns[0].counters.language.coherent, true);
});
