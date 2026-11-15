'use strict';
/**
 * The VC-M1.2 voice validation record: static evidence about the model file
 * and evidence from a real synthesis run are kept apart, and only the second
 * can turn the gate to PASS.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { LANGUAGES } = require('../../core/language/languages');
const { SPECIFICATION_EXPECTED, applicationVoices, buildVoiceValidation, describeVoiceValidation, blockedReason } = require('../../scripts/lib/voiceValidation');

const PACK = LANGUAGES.ru;
const SPEAKERS = ['aidar', 'baya', 'kseniya', 'eugene', 'xenia'];
const inspection = (speakers = SPEAKERS) => ({
  file: { bytes: 145420684, sha256: 'ab'.repeat(32) }, archive: { model_pickle: 'pkg/tts_models/model' }, method: 'inert',
  speakers, speaker_to_package: Object.fromEntries(speakers.map((s) => [s, 0])), packages: [], source: { refuses_unknown_speaker: true },
});
const smoke = (over = {}) => ({
  generated_at: 'T', ok: true, error: null, speakers: SPEAKERS, requested: { play: false },
  model: { model: 'v5_5_ru', device: 'cpu' },
  voices: Object.fromEntries(SPEAKERS.map((s, i) => [s, { audio_ms: 3000 + i, rms: 0.05, synthesis_ms: 400, sha256_pcm16: `h${i}` }])),
  checks: [{ name: 'The model reports its speakers', ok: true, detail: '' }, { name: 'xenia: audio produced and not silent', ok: true, detail: '' }],
  distinctness: { same_speaker_repeat: 0.4, smallest_between_speakers: 3.1 }, unknown_voice: { refused: true }, live_switch: { accepted: true, model_reloaded: false },
  ...over,
});

test('the application offers the five speakers of the model; xenia is the default', () => {
  const app = applicationVoices(PACK);
  assert.deepEqual([...app.voices].sort(), [...SPEAKERS].sort());
  assert.equal(app.defaultVoice, 'xenia');
  assert.equal(app.modelId, 'v5_5_ru');
  assert.deepEqual([...SPECIFICATION_EXPECTED].sort(), [...SPEAKERS].sort());
});

test('without a real synthesis run the gate is BLOCKED, whatever the model file says', () => {
  const v = buildVoiceValidation({ pack: PACK, inspection: inspection(), inspectionWhere: 'workspace', blocked: 'PyTorch cannot be installed here; pending run on the target PC', generatedAt: 'T' });
  assert.equal(v.modelFileInspection.status, 'PASS');
  assert.deepEqual(v.modelFileInspection.speakers, SPEAKERS);
  assert.equal(v.modelFileInspection.matchesApplication, true);
  assert.equal(v.modelFileInspection.matchesSpecification, true);
  assert.match(v.modelFileInspection.proves, /does not prove that any of them synthesizes/);
  assert.equal(v.realSynthesis.status, 'BLOCKED_PYTORCH_CANNOT_BE_INSTALLED_HERE_PENDING_RUN_ON_THE_TARGET_PC');
  assert.equal(v.REAL_SILERO_MULTI_SPEAKER_VALIDATION, v.realSynthesis.status);
  assert.equal(/PASS/.test(v.REAL_SILERO_MULTI_SPEAKER_VALIDATION), false);
  assert.match(describeVoiceValidation(v), /REAL_SILERO_MULTI_SPEAKER_VALIDATION: BLOCKED_/);
  assert.equal(blockedReason(''), 'NOT_RUN');
  assert.equal(buildVoiceValidation({ pack: PACK }).REAL_SILERO_MULTI_SPEAKER_VALIDATION, 'BLOCKED_NOT_RUN');
  assert.equal(buildVoiceValidation({ pack: PACK }).modelFileInspection.status, 'NOT_RUN');
});

test('a real run in which every speaker spoke and every check passed is PASS', () => {
  const v = buildVoiceValidation({ pack: PACK, inspection: inspection(), smoke: smoke(), smokeWhere: 'target PC', generatedAt: 'T' });
  assert.equal(v.REAL_SILERO_MULTI_SPEAKER_VALIDATION, 'PASS');
  assert.equal(v.realSynthesis.everySpeakerSpoke, true);
  assert.deepEqual(v.realSynthesis.speakersReportedByLoadedModel, SPEAKERS);
  assert.equal(v.realSynthesis.where, 'target PC');
  assert.deepEqual(v.realSynthesis.failedChecks, []);
  assert.equal(v.realSynthesis.played, false);
});

test('a real run is FAIL when a check failed, a speaker was silent, the run crashed or reported not ok', () => {
  const failing = [
    smoke({ checks: [{ name: 'An unknown voice is refused, not replaced', ok: false, detail: 'it was synthesized (hidden fallback)' }], ok: false }),
    smoke({ voices: { ...smoke().voices, eugene: { audio_ms: 0, rms: 0 } } }),
    smoke({ voices: { xenia: smoke().voices.xenia } }),
    smoke({ error: 'RuntimeError: boom', ok: false }),
    smoke({ ok: false }),
    smoke({ speakers: [], voices: {} }),
    // a "passing" report that the script itself did not mark ok is not upgraded
    { speakers: SPEAKERS, voices: smoke().voices, checks: [] },
  ];
  for (const s of failing) {
    const v = buildVoiceValidation({ pack: PACK, inspection: inspection(), smoke: s });
    assert.equal(v.REAL_SILERO_MULTI_SPEAKER_VALIDATION, 'FAIL', JSON.stringify(s).slice(0, 120));
  }
  const v = buildVoiceValidation({ pack: PACK, inspection: inspection(), smoke: failing[0] });
  assert.deepEqual(v.realSynthesis.failedChecks, ['An unknown voice is refused, not replaced']);
  assert.match(describeVoiceValidation(v), /failed: An unknown voice is refused/);
});

test('a model file whose speakers are not what the application offers fails the inspection and names the difference', () => {
  const v = buildVoiceValidation({ pack: PACK, inspection: inspection(['aidar', 'baya', 'kseniya', 'eugene', 'xenia', 'natasha']) });
  assert.equal(v.modelFileInspection.status, 'FAIL');
  assert.deepEqual(v.modelFileInspection.onlyInModel, ['natasha']);
  assert.deepEqual(v.modelFileInspection.onlyInApplication, []);
  const missing = buildVoiceValidation({ pack: PACK, inspection: inspection(['baya', 'xenia']) });
  assert.equal(missing.modelFileInspection.status, 'FAIL');
  assert.deepEqual([...missing.modelFileInspection.onlyInApplication].sort(), ['aidar', 'eugene', 'kseniya']);
  const noDefault = buildVoiceValidation({ pack: PACK, inspection: inspection(['aidar', 'baya', 'kseniya', 'eugene', 'oksana']) });
  assert.equal(noDefault.modelFileInspection.defaultVoicePresent, false);
  assert.equal(noDefault.modelFileInspection.status, 'FAIL');
  const unreadable = buildVoiceValidation({ pack: PACK, inspection: { error: 'model file not found' } });
  assert.deepEqual([unreadable.modelFileInspection.status, unreadable.modelFileInspection.error], ['FAIL', 'model file not found']);
  // a passing inspection never upgrades a failed or missing synthesis
  assert.equal(buildVoiceValidation({ pack: PACK, inspection: inspection(), smoke: smoke({ ok: false }) }).REAL_SILERO_MULTI_SPEAKER_VALIDATION, 'FAIL');
});
