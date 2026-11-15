'use strict';
/**
 * Character profiles (VC-M1.2).
 *
 * A character profile says WHO the companion is: a profile name for the UI,
 * the character's own name, a free-text description (the editable persona of
 * the system prompt) and the voice she speaks with. Nothing else. It does not
 * own the protected core (natural-conversation contract, system rules), the
 * conversation language, session history, memory or commands.
 *
 * Stored form (config `characters`, see config/README.md):
 *
 *   { activeId: "default",
 *     profiles: [ { id, displayName, characterName, description, voice: { provider, id } } ] }
 *
 *   id            stable identifier, never derived from the names
 *   displayName   profile name shown in the UI          ("" on the built-in profile = its default name)
 *   characterName the character's personal name         ("" = no name)
 *   description   persona text for the LLM              ("" = the default persona of the language)
 *   voice         { provider, id } of a TTS voice       (id "" = the default voice of the language)
 *
 * The built-in profile (id "default") always exists and cannot be deleted. It
 * is what the single persona of VC-M0/VC-M1.1 became: with nothing edited it
 * produces exactly the VC-M1.1 system prompt and the default voice.
 *
 * Everything here is a pure function of its arguments. The language-specific
 * texts and the voice catalogue come in through `ctx` (see characterContext),
 * so this module knows no language and no TTS provider. There is no behaviour
 * per kind of character anywhere: two characters differ only in the text of
 * `description` (and in their name and voice).
 */

const DEFAULT_PROFILE_ID = 'default';
const LIMITS = Object.freeze({ displayName: 60, characterName: 40, description: 4000, profiles: 24 });
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// line ends are stored as \n: a text field never produces \r, so a stored \r would never compare equal to what the form shows
const freeText = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const fill = (template, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), String(template));

/**
 * What profile handling needs from a language pack and the active TTS
 * provider: default texts and the voices that exist.
 */
function characterContext(pack, ttsProvider = 'silero') {
  const provider = String(ttsProvider || 'silero');
  const ttsPack = (pack.tts && pack.tts[provider]) || null;
  const texts = pack.character || {};
  return {
    provider,
    voiceIds: ttsPack ? ttsPack.voices.map((v) => v.id) : [],
    defaultVoice: ttsPack ? ttsPack.defaultVoice : '',
    defaultDescription: pack.llm.defaultPersona,
    defaultDisplayName: texts.defaultDisplayName || 'Default',
    newDisplayName: texts.newDisplayName || 'New profile',
    copyName: texts.copyName || '{name} (copy)',
    copyNameN: texts.copyNameN || '{name} (copy {n})',
  };
}

/** Voice reference in stored form. Accepts the object form or a bare voice id. */
function normalizeVoice(value, ctx, notes, where) {
  const src = isPlainObject(value) ? value : { id: typeof value === 'string' ? value : '' };
  const provider = oneLine(src.provider, 40) || ctx.provider;
  let id = oneLine(src.id, 80);
  if (provider === ctx.provider && id && !ctx.voiceIds.includes(id)) {
    notes.push(`${where}: voice '${id}' does not exist for ${provider}; using the default voice '${ctx.defaultVoice}'.`);
    id = '';
  }
  return { provider, id };
}

function uniqueId(wanted, used, index) {
  let base = ID_PATTERN.test(wanted) ? wanted : '';
  if (base && !used.has(base)) return base;
  if (!base) base = `profile-${index + 1}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base.slice(0, 36)}-${n}`;
  return id;
}

/**
 * Validate and repair stored profile data. Never throws; whatever comes in
 * (nothing, garbage, duplicates), the result has the built-in profile, unique
 * ids, valid voices and an active profile that exists.
 *
 *   legacyPersona / legacyVoice  values of the VC-M0/VC-M1.1 keys `persona.prompt`
 *                                and `tts.voice`; when present they become the
 *                                description and the voice of the built-in profile
 *                                (migration), so an edited persona is never lost.
 */
function normalizeCharacters(raw, ctx, { legacyPersona = '', legacyVoice = '' } = {}) {
  const notes = [];
  const source = isPlainObject(raw) ? raw : {};
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) notes.push('Character profiles were not readable; starting from the built-in profile.');
  let list = source.profiles;
  if (!Array.isArray(list)) {
    if (list !== undefined && list !== null) notes.push('The list of character profiles was not a list; starting from the built-in profile.');
    list = [];
  }

  const used = new Set();
  const profiles = [];
  list.forEach((entry, index) => {
    if (!isPlainObject(entry)) { notes.push(`Profile entry ${index + 1} was not readable and was dropped.`); return; }
    if (profiles.length >= LIMITS.profiles) { notes.push(`More than ${LIMITS.profiles} profiles; entry ${index + 1} was dropped.`); return; }
    const wanted = typeof entry.id === 'string' ? entry.id.trim() : '';
    const id = uniqueId(wanted, used, index);
    if (id !== wanted) notes.push(wanted && ID_PATTERN.test(wanted) ? `Duplicate profile id '${wanted}'; the later profile is now '${id}'.` : `Profile entry ${index + 1} had no usable id; it is now '${id}'.`);
    used.add(id);
    const builtIn = id === DEFAULT_PROFILE_ID;
    let displayName = oneLine(entry.displayName, LIMITS.displayName);
    if (builtIn && displayName === ctx.defaultDisplayName) displayName = '';
    if (!builtIn && !displayName) displayName = ctx.newDisplayName;
    let description = freeText(entry.description, LIMITS.description);
    if (description === ctx.defaultDescription) description = '';
    profiles.push({
      id,
      displayName,
      characterName: oneLine(entry.characterName, LIMITS.characterName),
      description,
      voice: normalizeVoice(entry.voice, ctx, notes, `Profile '${displayName || id}'`),
    });
  });

  let builtIn = profiles.find((p) => p.id === DEFAULT_PROFILE_ID);
  if (!builtIn) {
    builtIn = { id: DEFAULT_PROFILE_ID, displayName: '', characterName: '', description: '', voice: { provider: ctx.provider, id: '' } };
    profiles.unshift(builtIn);
  }

  // Migration of the single persona and the single voice of VC-M0 / VC-M1.1.
  const persona = freeText(legacyPersona, LIMITS.description);
  if (persona && persona !== ctx.defaultDescription) builtIn.description = persona;
  const voice = oneLine(legacyVoice, 80);
  if (voice) {
    if (ctx.voiceIds.includes(voice)) builtIn.voice = { provider: ctx.provider, id: voice };
    else notes.push(`Voice '${voice}' from the earlier configuration does not exist for ${ctx.provider}; the built-in profile keeps '${builtIn.voice.id || ctx.defaultVoice}'.`);
  }

  let activeId = typeof source.activeId === 'string' ? source.activeId.trim() : '';
  if (!profiles.some((p) => p.id === activeId)) {
    if (activeId) notes.push(`Active profile '${activeId}' does not exist; using the built-in profile.`);
    activeId = DEFAULT_PROFILE_ID;
  }
  return { activeId, profiles, notes };
}

/** One stored profile with every default filled in, as the UI and the prompt need it. */
function resolveProfile(profile, ctx) {
  const builtIn = profile.id === DEFAULT_PROFILE_ID;
  const sameProvider = profile.voice.provider === ctx.provider;
  const voiceKnown = sameProvider && ctx.voiceIds.includes(profile.voice.id);
  return {
    id: profile.id,
    builtIn,
    displayName: profile.displayName || (builtIn ? ctx.defaultDisplayName : ctx.newDisplayName),
    characterName: profile.characterName,
    description: profile.description || ctx.defaultDescription,
    descriptionIsDefault: !profile.description,
    voice: { provider: ctx.provider, id: voiceKnown ? profile.voice.id : ctx.defaultVoice },
    voiceIsDefault: !voiceKnown,
    // a voice of another provider is kept in the store but cannot be used now
    voiceUnavailable: !sameProvider && Boolean(profile.voice.id),
  };
}

/** All profiles resolved, plus the active one. Tolerates unnormalized input (and the legacy keys). */
function resolveCharacters(characters, ctx, legacy) {
  const norm = normalizeCharacters(characters, ctx, legacy);
  const profiles = norm.profiles.map((p) => resolveProfile(p, ctx));
  return { activeId: norm.activeId, active: profiles.find((p) => p.id === norm.activeId), profiles, notes: norm.notes };
}

// ---------------------------------------------------------------- editing --
// Each operation takes stored characters and returns new stored characters
// (already normalized). Nothing is mutated.

class CharacterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CharacterError';
    this.code = code;
  }
}

const cloneProfile = (p) => ({ ...p, voice: { ...p.voice } });

function defaultIdFactory() {
  // not derived from any name; random so that an id is not reused after a deletion
  return `p-${Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')}`;
}

function freshId(profiles, idFactory) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = String(idFactory());
    if (ID_PATTERN.test(id) && id !== DEFAULT_PROFILE_ID && !profiles.some((p) => p.id === id)) return id;
  }
  throw new CharacterError('no_id', 'Could not create a unique profile id');
}

function uniqueName(base, profiles, ctx, numbered) {
  const taken = new Set(profiles.map((p) => p.displayName || (p.id === DEFAULT_PROFILE_ID ? ctx.defaultDisplayName : '')));
  let name = numbered(1);
  for (let n = 2; taken.has(name) && n < 1000; n++) name = numbered(n);
  return name.slice(0, LIMITS.displayName) || base;
}

function requireRoom(profiles) {
  if (profiles.length >= LIMITS.profiles) throw new CharacterError('limit', `No more than ${LIMITS.profiles} profiles`);
}

function find(norm, id) {
  const profile = norm.profiles.find((p) => p.id === id);
  if (!profile) throw new CharacterError('not_found', `Profile '${id}' does not exist`);
  return profile;
}

const stored = (norm) => ({ activeId: norm.activeId, profiles: norm.profiles });

/** A new profile with the default persona and the default voice; it becomes the active one. */
function createProfile(characters, ctx, { idFactory = defaultIdFactory } = {}) {
  const norm = normalizeCharacters(characters, ctx);
  requireRoom(norm.profiles);
  const id = freshId(norm.profiles, idFactory);
  const displayName = uniqueName(ctx.newDisplayName, norm.profiles, ctx, (n) => (n === 1 ? ctx.newDisplayName : `${ctx.newDisplayName} ${n}`));
  const profiles = [...norm.profiles.map(cloneProfile), { id, displayName, characterName: '', description: '', voice: { provider: ctx.provider, id: '' } }];
  return { characters: stored(normalizeCharacters({ activeId: id, profiles }, ctx)), id };
}

/** A copy with a new id and a distinguishable name; the original is untouched; the copy becomes active. */
function duplicateProfile(characters, ctx, sourceId, { idFactory = defaultIdFactory } = {}) {
  const norm = normalizeCharacters(characters, ctx);
  const source = find(norm, sourceId);
  requireRoom(norm.profiles);
  const id = freshId(norm.profiles, idFactory);
  const sourceName = source.displayName || ctx.defaultDisplayName;
  const displayName = uniqueName(sourceName, norm.profiles, ctx, (n) => fill(n === 1 ? ctx.copyName : ctx.copyNameN, { name: sourceName.slice(0, LIMITS.displayName - 12), n }));
  const copy = { ...cloneProfile(source), id, displayName };
  const profiles = [...norm.profiles.map(cloneProfile), copy];
  return { characters: stored(normalizeCharacters({ activeId: id, profiles }, ctx)), id };
}

/** Remove a user-created profile. The built-in profile stays; deleting the active one activates the built-in. */
function deleteProfile(characters, ctx, id) {
  const norm = normalizeCharacters(characters, ctx);
  find(norm, id);
  if (id === DEFAULT_PROFILE_ID) throw new CharacterError('built_in', 'The built-in profile cannot be deleted');
  const profiles = norm.profiles.filter((p) => p.id !== id).map(cloneProfile);
  const activeId = norm.activeId === id ? DEFAULT_PROFILE_ID : norm.activeId;
  return { characters: stored(normalizeCharacters({ activeId, profiles }, ctx)) };
}

/** Replace the given fields of one profile (displayName, characterName, description, voice). */
function updateProfile(characters, ctx, id, fields = {}) {
  const norm = normalizeCharacters(characters, ctx);
  find(norm, id);
  if (fields.voice !== undefined) {
    const v = isPlainObject(fields.voice) ? fields.voice : { id: fields.voice };
    const provider = oneLine(v.provider, 40) || ctx.provider;
    const voiceId = oneLine(v.id, 80);
    if (provider === ctx.provider && voiceId && !ctx.voiceIds.includes(voiceId)) throw new CharacterError('voice', `Voice '${voiceId}' does not exist`);
  }
  const profiles = norm.profiles.map((p) => {
    if (p.id !== id) return cloneProfile(p);
    const next = cloneProfile(p);
    for (const key of ['displayName', 'characterName', 'description']) if (fields[key] !== undefined) next[key] = fields[key];
    if (fields.voice !== undefined) next.voice = isPlainObject(fields.voice) ? { ...fields.voice } : { provider: ctx.provider, id: fields.voice };
    return next;
  });
  return { characters: stored(normalizeCharacters({ activeId: norm.activeId, profiles }, ctx)) };
}

function setActiveProfile(characters, ctx, id) {
  const norm = normalizeCharacters(characters, ctx);
  find(norm, id);
  return { characters: stored({ ...norm, activeId: id }) };
}

/** Does saving `after` instead of `before` change who the character is (name or description)? */
function identityChanged(before, after) {
  return before.characterName !== after.characterName || before.description !== after.description;
}

module.exports = {
  DEFAULT_PROFILE_ID, LIMITS, ID_PATTERN, CharacterError,
  characterContext, normalizeCharacters, resolveCharacters, resolveProfile,
  createProfile, duplicateProfile, deleteProfile, updateProfile, setActiveProfile, identityChanged,
};
