'use strict';
/**
 * Persona switching evaluation (VC-M1.2).
 *
 * Question: when the active character profile changes, does the model answer
 * as that character — and does it still follow the protected core?
 *
 * Path of every request (the application's own, nothing evaluation-only):
 *   characterProfiles (create / update a profile, make it active)
 *   normalizeConfig → resolveLanguageProfile(config).llm.systemPrompt
 *   SessionHistory (a fresh one per conversation) → buildMessages
 *   LMStudioProvider.streamChat with the configured generation settings
 *
 * The characters below are TEMPORARY and exist only for this evaluation: they
 * are created in a configuration held in memory and are never written to
 * config/user.json. They are not a character library and nothing in the
 * application knows about them. Their only purpose is to be clearly different
 * from each other in ways that can be read off a reply: how the user is
 * addressed and what the character says her name is.
 *
 * What is decided here (the verdict) is only what can be read off the replies
 * mechanically: every request answered, the name follows the profile, the form
 * of address follows the profile, no name of another character appears in a
 * profile that has a name of its own, nothing characteristic of another
 * character appears in any reply, and no request contains another profile.
 *
 * Gate 11 (owner's decision, 2026-10-10): the name is checked only for profiles
 * with an explicitly set name. A profile without a name (the built-in one) may
 * invent one when asked, and if the invention happens to be another test
 * character's name that is recorded as an observation, not a failure. Profile
 * isolation is checked independently of names: (1) in the prompts — no
 * profile's system prompt contains another profile's description or name, the
 * mechanism through which instructions could leak; (2) in the replies — no
 * reply of any profile carries another character's characteristic markers
 * (her role, her relationship to the user).
 * Everything else — the natural-conversation detector, questions, length — is
 * recorded as observations. Whether a character FEELS right is decided by the
 * user in the manual acceptance. This is not a psychological or medical test.
 */
const crypto = require('node:crypto');
const { LMStudioProvider } = require('../../core/providers/lmStudioProvider');
const { resolveLanguageProfile, LANGUAGES } = require('../../core/language/languages');
const { normalizeConfig } = require('../../core/config/configStore');
const characterProfiles = require('../../core/characters/characterProfiles');
const { turnHintFor } = require('../../core/conversation/turnHints');
const { collectConversations, analyzeRecords } = require('./conversationEval');

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `expect.address`  the form of address the description asks for
 * `nameForms`       the character's name in any grammatical case
 * `traits`          what only this character would say about herself: her role or her relationship
 *                   to the user, taken from her description. Found in a reply of ANOTHER profile it
 *                   means her instructions reached that profile. Kept narrow on purpose: checked
 *                   against 1417 saved replies of the three profiles, no false finding.
 */
const PERSONAS = [
  {
    id: 'default', title: 'the built-in profile, untouched (control: the VC-M1.1 prompt)', builtIn: true,
    profile: null, expect: { address: null, name: null },
  },
  {
    id: 'close_friend', title: 'temporary character: a casual close friend',
    profile: {
      displayName: 'Проверка: близкая подруга', characterName: 'Лена', voice: 'kseniya',
      description: 'Ты — давняя близкая подруга собеседника, вы знакомы много лет. Вы на «ты». Говоришь просто, тепло и по-свойски, как говорят между собой близкие люди, можешь пошутить или поддеть. Сейчас вы вдвоём сидите у него дома.',
    },
    expect: { address: 'informal', name: 'Лена' }, nameForms: 'Лен(?:а|ы|е|у|ой|ою|очка|очки|очке|очку|очкой|ка|ки|ке|ку|кой)',
    traits: '(?:давн(?:яя|ей|юю|ий|ие|их)\\s+(?:близк[а-яё]+\\s+)?подруг[а-яё]*|(?:знакомы|дружим)\\s+(?:уже\\s+)?(?:много|столько|сто|сколько)\\s+лет)',
  },
  {
    id: 'session_therapist', title: 'temporary character: a formal, session-style therapist',
    profile: {
      displayName: 'Проверка: сессия', characterName: 'Анна', voice: 'baya',
      description: 'Ты — психотерапевт, сейчас идёт очная сессия, собеседник — твой клиент. Обращаешься к нему только на «вы». Говоришь спокойно, сдержанно и внимательно, без панибратства и шуток, не торопишь.',
    },
    expect: { address: 'formal', name: 'Анна' }, nameForms: 'Анн(?:а|ы|е|у|ой|ою)',
    traits: '(?:(?:психо)?терапевт[а-яё]*|психотерап[а-яё]+|(?:наш[а-яё]*|эт[а-яё]+|на|сегодняшн[а-яё]+|очн[а-яё]+)\\s+сесси[а-яё]*|клиент[а-яё]*)',
  },
];

/**
 * Neutral user lines: the same for every character, none of them names a role
 * or asks for a style. `probe` marks what a scenario is read for.
 */
const SCENARIOS = [
  { id: 'P1', set: 'persona', title: 'greeting', turns: ['Привет.'] },
  { id: 'P2', set: 'persona', title: 'the name question', probe: 'name', turns: ['Как тебя зовут?'] },
  { id: 'P3', set: 'persona', title: 'personal statement (worn out)', turns: ['Что-то я сегодня совсем вымотался.'] },
  { id: 'P4', set: 'persona', title: 'trouble at work, short answers', turns: ['На работе опять завал.', 'Да не знаю, просто всё разом навалилось.', 'Ладно.'] },
  { id: 'P5', set: 'persona', title: 'everyday news', turns: ['Я вчера наконец досмотрел тот сериал.'] },
  { id: 'P6', set: 'persona', title: 'a mood', turns: ['Мне сегодня как-то не по себе.', 'Сам не пойму почему.'] },
];

// ---- reading a reply ------------------------------------------------------
const B = '(?<![а-яё])';
const E = '(?![а-яё])';
const INFORMAL_PRONOUN = new RegExp(`${B}(?:ты|тебя|тебе|тобой|тобою|тво(?:й|я|ё|е|и|его|ей|ю|им|ими|их|ём|ем))${E}`, 'gi');
const FORMAL_PRONOUN = new RegExp(`${B}(?:вы|вас|вам|вами|ваш(?:а|е|и|его|ей|у|им|ими|их|ем)?)${E}`, 'gi');
// second person singular verbs («хочешь», «устал… расскажешь») minus the few ordinary words with the same ending
const INFORMAL_VERB = new RegExp(`${B}[а-яё]{2,}(?:ешь|ёшь|ишь)(?:ся)?${E}`, 'gi');
const NOT_VERBS = new Set(['лишь', 'тишь', 'брешь', 'плешь', 'вишь', 'мышь']);
// formal second person: a closed list of frequent verbs and imperatives (open endings like «-ете» also end many nouns)
const FORMAL_VERB = new RegExp(`${B}(?:расскажите|скажите|опишите|поделитесь|попробуйте|подумайте|представьте|простите|извините|давайте|хотите|можете|чувствуете|думаете|считаете|знаете|понимаете|помните|видите|замечаете|ощущаете|готовы|хотели|могли|устали|будете|сможете|захотите|назов[её]те|обратите|позвольте|скажете|расскажете)${E}`, 'gi');

/** How one reply addresses the user: 'informal' («ты»), 'formal' («вы»), 'mixed' or 'none'. */
function addressForm(reply) {
  const text = String(reply || '');
  const count = (re) => (text.match(re) || []);
  const informal = count(INFORMAL_PRONOUN).length + count(INFORMAL_VERB).filter((w) => !NOT_VERBS.has(w.toLowerCase())).length;
  const formal = count(FORMAL_PRONOUN).length + count(FORMAL_VERB).length;
  const form = informal && formal ? 'mixed' : informal ? 'informal' : formal ? 'formal' : 'none';
  return { form, informal, formal };
}

/** Which of the evaluation characters' names occur in a reply. */
function namesIn(reply, personas = PERSONAS) {
  return personas.filter((p) => p.nameForms && new RegExp(`${B}${p.nameForms}${E}`, 'i').test(String(reply || ''))).map((p) => p.expect.name);
}

/** Which evaluation characters' characteristic markers (role, relationship) occur in a reply. */
function traitsIn(reply, personas = PERSONAS) {
  return personas.filter((p) => p.traits && new RegExp(`${B}${p.traits}${E}`, 'i').test(String(reply || ''))).map((p) => p.id);
}

/**
 * Isolation in the prompts, independent of any reply: the system prompt of
 * every profile must not contain another profile's description or name. This
 * is the only way the instructions of one profile could reach another (every
 * conversation also starts with an empty session history).
 */
function promptIsolation(variants) {
  const leaks = [];
  for (const v of variants) {
    for (const o of variants) {
      if (o === v) continue;
      const desc = o.character && o.character.description;
      if (desc && desc !== (v.character && v.character.description) && v.systemPrompt.includes(desc)) leaks.push({ profile: v.id, contains: 'description', of: o.id });
      const name = o.character && o.character.characterName;
      if (name && name !== (v.character && v.character.characterName) && new RegExp(`${B}${name}${E}`, 'i').test(v.systemPrompt)) leaks.push({ profile: v.id, contains: 'name', of: o.id });
    }
  }
  return { isolated: variants.length > 0 && leaks.length === 0, profilesChecked: variants.map((v) => v.id), leaks };
}

// ---- the application path -------------------------------------------------
/**
 * For each evaluation character: a configuration in which it is the ACTIVE
 * profile (made with the application's own profile operations), and the system
 * prompt the application builds from it. The base configuration is not changed.
 */
function personaVariants(baseConfig, defaults, personas = PERSONAS) {
  const base = JSON.parse(JSON.stringify(baseConfig));
  // start from the built-in profile as shipped, so that the control really is the VC-M1.1 prompt
  // and a persona the user is working on at home does not take part in the evaluation
  const clean = normalizeConfig({ ...base, characters: { activeId: characterProfiles.DEFAULT_PROFILE_ID, profiles: [] }, persona: { prompt: '' }, tts: { ...base.tts, voice: '' } }, defaults);
  const pack = LANGUAGES[resolveLanguageProfile(clean).code];
  const ctx = characterProfiles.characterContext(pack, clean.tts.provider);
  return personas.map((p) => {
    let config = clean;
    if (p.profile) {
      const made = characterProfiles.createProfile(clean.characters, ctx);
      const edited = characterProfiles.updateProfile(made.characters, ctx, made.id, p.profile);
      config = normalizeConfig({ ...clean, characters: edited.characters }, defaults);
    }
    const profile = resolveLanguageProfile(config);
    return {
      id: p.id, title: p.title, expect: p.expect, nameForms: p.nameForms || null,
      character: {
        builtIn: profile.character.builtIn, displayName: profile.character.displayName, characterName: profile.character.characterName,
        description: p.profile ? p.profile.description : pack.llm.defaultPersona, voice: profile.tts.voice,
        personaSection: profile.llm.persona,   // what the [persona] section of the prompt contains
      },
      config, systemPrompt: profile.llm.systemPrompt, coreInstructions: profile.llm.coreInstructions,
    };
  });
}

// ---- analysis -------------------------------------------------------------
function analyzeVariant(variant, records, scenarios = SCENARIOS, personas = PERSONAS) {
  const base = analyzeRecords(records, scenarios);
  const probes = new Map(scenarios.map((s) => [s.id, s.probe || null]));
  const others = personas.filter((p) => p.expect.name && p.expect.name !== variant.expect.name).map((p) => p.expect.name);
  const otherIds = personas.filter((p) => p.id !== variant.id).map((p) => p.id);
  const replies = base.replies.map((r) => {
    const names = namesIn(r.reply, personas);
    const traits = traitsIn(r.reply, personas);
    return { ...r, address: addressForm(r.reply), names, foreignNames: names.filter((n) => others.includes(n)), foreignTraits: traits.filter((t) => otherIds.includes(t)), probe: probes.get(r.scenario) };
  });
  const answered = replies.filter((r) => r.outcome === 'ok' && r.reply);
  const forms = { informal: 0, formal: 0, mixed: 0, none: 0 };
  for (const r of answered) forms[r.address.form] += 1;
  const nameReplies = answered.filter((r) => r.probe === 'name');
  const want = variant.expect.name;
  const withForeignName = answered.filter((r) => r.foreignNames.length);
  return {
    summary: {
      ...base.summary,
      address: forms,
      nameQuestion: {
        asked: nameReplies.length,
        saysOwnName: want ? nameReplies.filter((r) => r.names.includes(want)).length : null,
        saysAnotherCharactersName: nameReplies.filter((r) => r.foreignNames.length).length,
        replies: nameReplies.map((r) => r.reply),
      },
      repliesWithAnotherCharactersName: withForeignName.length,
      // gate 11: decides only for a profile with its own name; for a profile without one it is an observation
      nameCheckApplies: Boolean(want),
      inventedNames: want ? null : withForeignName.map((r) => ({ key: `${r.scenario}.${r.run}.${r.turn}`, names: r.foreignNames, reply: r.reply })),
      repliesWithAnotherCharactersTraits: answered.filter((r) => r.foreignTraits.length).length,
      anotherCharactersTraits: answered.filter((r) => r.foreignTraits.length).map((r) => ({ key: `${r.scenario}.${r.run}.${r.turn}`, of: r.foreignTraits, reply: r.reply })),
    },
    perScenario: base.perScenario,
    detectedFailures: base.detectedFailures,
    replies,
  };
}

/** The mechanical checks for one character. `null` = not applicable (the control has no expectation). */
function verdictFor(variant, analysis) {
  const s = analysis.summary;
  const answered = s.replies > 0 && s.answered === s.replies;
  const want = variant.expect;
  const a = s.address;
  const addressed = a.informal + a.formal + a.mixed;
  const address = want.address === null ? null
    : addressed > 0 && (want.address === 'informal' ? a.informal > a.formal + a.mixed : a.formal > a.informal + a.mixed);
  const name = want.name === null ? null : s.nameQuestion.asked > 0 && s.nameQuestion.saysOwnName === s.nameQuestion.asked;
  // gate 11: another character's name counts only against a profile that has a name of its own
  const noOtherName = want.name ? s.repliesWithAnotherCharactersName === 0 : null;
  const noOtherTraits = s.repliesWithAnotherCharactersTraits === 0;
  return { answered, addressFollowsProfile: address, nameFollowsProfile: name, noOtherCharactersName: noOtherName, noOtherCharactersTraits: noOtherTraits, ok: answered && address !== false && name !== false && noOtherName !== false && noOtherTraits };
}

const LIMITS = [
  'The verdict covers only what can be read off a reply mechanically: answered, the name, the form of address, no other character\'s name (profiles with a name of their own), no other character\'s characteristic markers, and no other profile in any prompt.',
  'A profile without a name (the built-in one) may invent a name when asked; if it is another test character\'s name, that is an observation (inventedNames), not a failure (owner\'s decision for gate 11, 2026-10-10).',
  'The characteristic markers are narrow word lists (role, relationship): they catch a leak that shows in the wording, not every possible one. The prompt check is the independent proof that no profile\'s request contains another profile.',
  'The form of address is found with word lists; a reply that addresses nobody counts as "none" and is left out of the comparison.',
  'The natural-conversation detector numbers are observations. They are not part of the verdict and the contract was not tuned on these scenarios.',
  'Sampling is random (application temperature), so counts vary between runs.',
  'The characters are temporary test characters. This says nothing about the psychological or medical quality of any character.',
  'Whether a character feels right in a real conversation is decided by the user (manual acceptance).',
];

/**
 * The report from raw records.
 *   variants  output of personaVariants(), each with `records` added
 */
function buildPersonaReport({ config, model, runs, variants, scenarios = SCENARIOS, personas = PERSONAS, thinkingControl = null, generatedAt = new Date().toISOString() }) {
  const report = {
    stage: 'VC-M1.2', kind: 'REAL_MODEL_PERSONA_EVALUATION', generatedAt,
    endpoint: config.llm.endpoint, model, ok: false,
    promptPath: 'characterProfiles (create/update, active) → normalizeConfig → resolveLanguageProfile → SessionHistory → buildMessages → LMStudioProvider.streamChat (the application modules, application settings)',
    settings: { temperature: config.llm.temperature, topP: config.llm.topP, topK: config.llm.topK, maxTokens: config.llm.maxTokens, disableThinking: config.llm.disableThinking, historyTurns: config.session.historyTurns },
    perTurnNotes: { premiseCheck: Boolean(config.conversation && config.conversation.premiseCheck === true), lengthVariation: Boolean(config.conversation && config.conversation.lengthVariation === true), formalAddress: 'a reminder on every turn of a character whose description asks for «вы» (core/conversation/turnHints.js)' },
    runsPerScenario: runs,
    scenarios: scenarios.map((s) => ({ id: s.id, title: s.title, probe: s.probe || null, turns: s.turns })),
    sessionIsolation: 'Every conversation starts with an empty session history, as after a profile switch in the application: no request of one character contains anything said to or by another.',
    limits: LIMITS,
    thinkingControl,
    protectedCore: null,
    variants: {},
    verdict: null,
  };
  const cores = new Set();
  for (const v of variants) {
    const analysis = analyzeVariant(v, v.records || [], scenarios, personas);
    cores.add(v.coreInstructions);
    report.variants[v.id] = {
      title: v.title, character: v.character, expect: v.expect,
      systemPromptChars: v.systemPrompt.length, systemPromptSha256: sha256(v.systemPrompt),
      protectedCoreUnchanged: v.systemPrompt.endsWith(`\n\n${v.coreInstructions}`),
      ...analysis, verdict: verdictFor(v, analysis),
    };
  }
  const anyCore = variants.length ? variants[0].coreInstructions : '';
  report.protectedCore = { sha256: sha256(anyCore), chars: anyCore.length, identicalForEveryCharacter: cores.size === 1 && Object.values(report.variants).every((v) => v.protectedCoreUnchanged) };
  const list = Object.values(report.variants);
  const characters = list.filter((v) => v.expect.address !== null || v.expect.name !== null);
  const named = list.filter((v) => v.expect.name);
  const every = (pick) => list.length > 0 && list.every(pick);
  report.isolation = {
    rule: 'Gate 11 (owner, 2026-10-10): the name is checked only for profiles with an explicitly set name; profile isolation is checked independently, in the prompts and in the replies.',
    prompts: promptIsolation(variants),
    replies: Object.fromEntries(Object.entries(report.variants).map(([id, v]) => [id, { anotherCharactersTraits: v.summary.repliesWithAnotherCharactersTraits, anotherCharactersName: v.summary.repliesWithAnotherCharactersName, nameCheckApplies: v.summary.nameCheckApplies }])),
    inventedNamesInProfilesWithoutName: Object.fromEntries(Object.entries(report.variants).filter(([, v]) => !v.summary.nameCheckApplies).map(([id, v]) => [id, v.summary.inventedNames])),
  };
  report.verdict = {
    everyRequestAnswered: every((v) => v.verdict.answered),
    nameFollowsProfile: characters.length >= 2 && characters.every((v) => v.verdict.nameFollowsProfile === true),
    addressFollowsProfile: characters.length >= 2 && characters.every((v) => v.verdict.addressFollowsProfile === true),
    noOtherCharactersName: named.length > 0 && named.every((v) => v.verdict.noOtherCharactersName === true),
    noOtherCharactersTraits: every((v) => v.verdict.noOtherCharactersTraits === true),
    profilesIsolatedInPrompts: report.isolation.prompts.isolated,
    protectedCoreIdentical: report.protectedCore.identicalForEveryCharacter,
    charactersCompared: characters.length,
  };
  report.verdict.status = Object.entries(report.verdict).every(([k, v]) => k === 'charactersCompared' || v === true) ? 'PASS' : 'FAIL';
  // "ok" = the evaluation itself worked (every request was answered); the verdict is separate
  report.ok = report.verdict.everyRequestAnswered;
  return report;
}

function describePersonaReport(report, say) {
  for (const [id, v] of Object.entries(report.variants)) {
    const s = v.summary;
    const a = s.address;
    say(`${id}: ${s.answered}/${s.replies} answered; address informal ${a.informal} / formal ${a.formal} / mixed ${a.mixed} / none ${a.none}` +
      `${v.expect.address ? ` (expected ${v.expect.address}: ${v.verdict.addressFollowsProfile ? 'yes' : 'NO'})` : ''}; ` +
      `name question ${s.nameQuestion.saysOwnName === null ? '—' : `${s.nameQuestion.saysOwnName}/${s.nameQuestion.asked} say «${v.expect.name}»`}; ` +
      `another character's name in ${s.repliesWithAnotherCharactersName}${s.nameCheckApplies ? '' : ' (no name of its own: observation)'}; another character's traits in ${s.repliesWithAnotherCharactersTraits}; detector findings in ${s.assistantLike} (managing/offering ${s.managementLike}, advice ${s.adviceLike}); ` +
      `ends with a question ${s.endsWithQuestion}; mean ${s.words.mean} words; spoken-rule issues ${s.withSpokenIssues}`);
  }
  say('');
  const d = report.verdict;
  say(`Protected core identical for every character: ${d.protectedCoreIdentical ? 'yes' : 'NO'}`);
  say(`Name follows the profile: ${d.nameFollowsProfile ? 'yes' : 'NO'}; address follows the profile: ${d.addressFollowsProfile ? 'yes' : 'NO'}; no other character's name (named profiles): ${d.noOtherCharactersName ? 'yes' : 'NO'}; no other character's traits: ${d.noOtherCharactersTraits ? 'yes' : 'NO'}; profiles isolated in the prompts: ${d.profilesIsolatedInPrompts ? 'yes' : 'NO'}`);
  say(`REAL_PERSONA_SWITCHING_EVALUATION: ${report.ok ? d.status : 'INCOMPLETE'}`);
}

/** The whole evaluation against a server: connect, play every character, build the report. */
async function runPersonaEval({ config, defaults, fetchImpl, runs = 3, say = console.log, scenarios = SCENARIOS, personas = PERSONAS }) {
  const provider = new LMStudioProvider({ getConfig: () => config.llm, fetchImpl });
  const variants = personaVariants(config, defaults, personas);
  say(`Endpoint: ${config.llm.endpoint}`);
  const conn = await provider.checkConnectivity();
  if (!conn.ok) {
    const report = buildPersonaReport({ config, model: null, runs, variants: [], scenarios, personas });
    report.error = `LM Studio could not be used: ${conn.error}`;
    say(report.error);
    return report;
  }
  say(`Model   : ${conn.selectedModel} (${conn.selectedReason})`);
  say(`${variants.length} characters; ${runs} run(s) per scenario; ${scenarios.reduce((n, s) => n + s.turns.length, 0) * runs} replies per character`);
  for (const v of variants) {
    say('');
    say(`=== ${v.id}: ${v.title} ===`);
    // exactly what the application sends with this profile active, per-turn notes included (core/conversation/turnHints.js)
    const llm = resolveLanguageProfile(v.config).llm;
    v.records = await collectConversations({ provider, model: conn.selectedModel, systemPrompt: v.systemPrompt, historyTurns: config.session.historyTurns, scenarios, runs, say, turnHint: (u) => turnHintFor({ userText: u, llm, conversation: v.config.conversation }) });
  }
  const report = buildPersonaReport({ config, model: conn.selectedModel, runs, variants, scenarios, personas, thinkingControl: provider.thinkingControl(conn.selectedModel) });
  say('');
  describePersonaReport(report, say);
  return report;
}

module.exports = { PERSONAS, SCENARIOS, LIMITS, addressForm, namesIn, traitsIn, promptIsolation, personaVariants, analyzeVariant, verdictFor, buildPersonaReport, describePersonaReport, runPersonaEval };
