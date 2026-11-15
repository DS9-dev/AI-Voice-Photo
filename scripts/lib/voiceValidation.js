'use strict';
/**
 * VC-M1.2 voice validation record (artifacts/reports/VC_M1_2_VOICE_VALIDATION.json).
 *
 * Two kinds of evidence are kept apart on purpose:
 *
 *   modelFileInspection  what the model FILE says its speakers are (read
 *                        without loading the model: services/voice_service/model_speakers.py);
 *   realSynthesis        what the LOADED model did when every speaker was
 *                        asked to speak (services/voice_service/voice_smoke.py).
 *
 * The first never stands in for the second: without a real synthesis run the
 * verdict is BLOCKED_<reason>, whatever the file says.
 *
 * Pure functions; the CLI is scripts/voice_smoke.js.
 */

/** The voice list of the VC-M1.2 task text. It is a claim to verify, not a source of truth. */
const SPECIFICATION_EXPECTED = Object.freeze(['xenia', 'baya', 'kseniya', 'aidar', 'eugene']);

const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const blockedReason = (text) => String(text || 'NOT_RUN').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'NOT_RUN';

/** What the application offers, taken from the language pack. */
function applicationVoices(pack, provider = 'silero') {
  const tts = (pack.tts && pack.tts[provider]) || { voices: [] };
  return { provider, modelId: tts.modelId || '', defaultVoice: tts.defaultVoice || '', voices: tts.voices.map((v) => v.id), previewText: tts.previewText || '' };
}

function inspectionSection(inspection, app, where) {
  if (!inspection) return { status: 'NOT_RUN', where: where || null };
  if (inspection.error) return { status: 'FAIL', where: where || null, error: inspection.error };
  const speakers = Array.isArray(inspection.speakers) ? inspection.speakers : [];
  const matchesApplication = sameSet(speakers, app.voices);
  return {
    status: speakers.length && matchesApplication && speakers.includes(app.defaultVoice) ? 'PASS' : 'FAIL',
    where: where || null,
    proves: 'Which speakers the model file contains. It does not prove that any of them synthesizes.',
    file: inspection.file || null,
    archive: inspection.archive || null,
    method: inspection.method || null,
    speakers,
    speakerToPackage: inspection.speaker_to_package ?? null,
    packages: inspection.packages ?? null,
    modelSource: inspection.source ?? null,
    matchesApplication,
    matchesSpecification: sameSet(speakers, SPECIFICATION_EXPECTED),
    defaultVoicePresent: speakers.includes(app.defaultVoice),
    onlyInModel: speakers.filter((s) => !app.voices.includes(s)),
    onlyInApplication: app.voices.filter((s) => !speakers.includes(s)),
  };
}

function synthesisSection(smoke, app, { where, blocked } = {}) {
  if (!smoke) {
    return {
      status: `BLOCKED_${blockedReason(blocked)}`,
      where: null,
      note: 'No real synthesis has been recorded. Run voice_smoke.bat --record on the target PC.',
    };
  }
  const speakers = Array.isArray(smoke.speakers) ? smoke.speakers : [];
  const voices = smoke.voices || {};
  const checks = Array.isArray(smoke.checks) ? smoke.checks : [];
  const failed = checks.filter((c) => !c.ok);
  const everySpeakerSpoke = speakers.length > 0 && speakers.every((s) => voices[s] && voices[s].audio_ms > 0 && voices[s].rms > 0);
  const ok = smoke.ok === true && !smoke.error && failed.length === 0 && everySpeakerSpoke;
  return {
    status: ok ? 'PASS' : 'FAIL',
    where: where || null,
    proves: 'With the real model loaded once: every speaker synthesized non-silent audio, the speakers differ from each other, an unknown voice is refused, and a voice change applies to the next synthesis without a reload.',
    generatedAt: smoke.generated_at || null,
    model: smoke.model || null,
    requested: smoke.requested || null,
    speakersReportedByLoadedModel: speakers,
    matchesApplication: sameSet(speakers, app.voices),
    matchesSpecification: sameSet(speakers, SPECIFICATION_EXPECTED),
    everySpeakerSpoke,
    voices,
    distinctness: smoke.distinctness || null,
    unknownVoice: smoke.unknown_voice || null,
    liveSwitch: smoke.live_switch || null,
    played: Boolean(smoke.requested && smoke.requested.play),
    checks,
    failedChecks: failed.map((c) => c.name),
    error: smoke.error || null,
  };
}

/**
 * Build the record.
 *   pack               language pack (core/language/languages.js)
 *   inspection         result of model_speakers.py (or {error}), or null
 *   inspectionWhere    where that file was read
 *   smoke              report of voice_smoke.py, or null when it has not run
 *   smokeWhere         where it ran
 *   blocked            why there is no real synthesis (used only when smoke is null)
 */
function buildVoiceValidation({ pack, provider = 'silero', inspection = null, inspectionWhere = null, smoke = null, smokeWhere = null, blocked = null, generatedAt = new Date().toISOString() }) {
  const app = applicationVoices(pack, provider);
  const modelFileInspection = inspectionSection(inspection, app, inspectionWhere);
  const realSynthesis = synthesisSection(smoke, app, { where: smokeWhere, blocked });
  return {
    milestone: 'VC-M1.2',
    subject: 'Voices of the installed Silero TTS model and their selection',
    generatedAt,
    applicationVoices: app,
    specificationExpected: [...SPECIFICATION_EXPECTED],
    modelFileInspection,
    realSynthesis,
    // the gate: only a real run with the loaded model can make it PASS
    REAL_SILERO_MULTI_SPEAKER_VALIDATION: realSynthesis.status,
  };
}

function describeVoiceValidation(v) {
  const lines = [];
  const m = v.modelFileInspection;
  lines.push(`Application offers: ${v.applicationVoices.voices.join(', ')} (default ${v.applicationVoices.defaultVoice})`);
  lines.push(`Model file:         ${m.status}${m.speakers ? ` — speakers ${m.speakers.join(', ')}` : ''}${m.error ? ` — ${m.error}` : ''}`);
  const r = v.realSynthesis;
  lines.push(`Real synthesis:     ${r.status}${r.speakersReportedByLoadedModel ? ` — ${r.speakersReportedByLoadedModel.join(', ')}` : ''}`);
  if (r.failedChecks && r.failedChecks.length) lines.push(`  failed: ${r.failedChecks.join('; ')}`);
  lines.push(`REAL_SILERO_MULTI_SPEAKER_VALIDATION: ${v.REAL_SILERO_MULTI_SPEAKER_VALIDATION}`);
  return lines.join('\n');
}

module.exports = { SPECIFICATION_EXPECTED, applicationVoices, buildVoiceValidation, describeVoiceValidation, blockedReason };
