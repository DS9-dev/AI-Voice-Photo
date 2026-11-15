'use strict';

/**
 * Conversation-language registry.
 *
 * ONE application setting (`conversation.language`) selects a language pack,
 * and every provider derives its language-specific configuration from that
 * pack: the STT recognition language, the LLM instruction, and the TTS
 * model/voices. Nothing else in the application hard-codes a language.
 *
 * The LLM system prompt has two separate layers:
 *   1. the persona (identity, personality, style, situation) — user-editable:
 *      the description (and name) of the active character profile, see
 *      core/characters/characterProfiles.js; only the default text is defined here;
 *   2. the protected core — defined here, not editable by the user, in two
 *      sections:
 *        - natural conversation behaviour (VC-M1.1): take part in the
 *          conversation instead of managing it;
 *        - system rules: language, spoken-answer protocol, no claimed
 *          physical actions (an action is reported as done only after the
 *          system reports it; no action executor exists yet).
 *
 * Each language pack carries its own text for every section; the assembly
 * (`buildSystemPrompt`) is the same for all languages.
 *
 * Adding a language later = adding one entry here (plus a text normalizer
 * for the TTS provider in the voice service). Conversation Core does not
 * change.
 *
 * This is the language spoken by the user and the companion. It is unrelated
 * to the language of the user interface (`ui.language`).
 */
const { characterContext, resolveCharacters, LIMITS: CHARACTER_LIMITS } = require('../characters/characterProfiles');

const LANGUAGES = Object.freeze({
  ru: Object.freeze({
    code: 'ru',
    name: 'Русский',
    englishName: 'Russian',
    validated: true, // the only language validated in VC-M0
    stt: { language: 'ru' },
    llm: {
      // Layer 2, user-editable (Settings → «Персонаж»). This is only the DEFAULT
      // text: the description of the built-in character profile and the
      // starting text of a new one. The active persona is the description of
      // the active profile in the configuration (`characters`, empty = this default).
      defaultPersona: [
        'Ты — девушка, которая находится в одной комнате с собеседником и разговаривает с ним вживую.',
        'Общайся естественно и непринуждённо, как человек рядом, а не как справочная система или виртуальный помощник.',
        'Обычно отвечай коротко и естественно, если ситуация не требует подробного ответа.',
      ].join('\n\n'),
      // Protected core, section 1 (VC-M1.1): how to take part in a conversation.
      // THE definition of the natural-conversation behaviour: nothing else in
      // the application states, repeats or enforces it (no reply is filtered
      // or rewritten). The wording was chosen by measurement on the target
      // model; see docs/legacy/VC_M1_1_NATURAL_CONVERSATION.md before changing it.
      // Owner's decision of 2026-10-12: the opening line no longer places her
      // («как говорил бы человек, который сидит рядом»); where she is and how
      // close she is to the user belong to the character's description.
      conversation: {
        intro: 'Ты собеседница: участвуешь в разговоре, а не ведёшь его и не обслуживаешь собеседника. Говори так, как говорил бы живой человек.',
        rules: [
          { id: 'stay_on_topic', text: 'Оставайся в той теме, о которой сейчас идёт речь. Тему меняет собеседник или сам ход разговора; сама не предлагай её сменить и не спрашивай, о чём поговорить.' },
          { id: 'no_forced_question', text: 'Не заканчивай реплику вопросом по привычке. Обычно реплика заканчивается утверждением: ты реагируешь, соглашаешься, споришь или добавляешь что-то своё — и всё. Вопрос задавай изредка, когда тебе правда любопытна какая-то деталь и не спросить было бы странно. Тогда это один короткий прямой вопрос без вариантов ответа через «или».' },
          { id: 'no_unrequested_offers', text: 'Сама, без просьбы, не предлагай помощь, поддержку и занятия, не советуй, что собеседнику делать, не рассказывай, что ты умеешь, и не приглашай обращаться к тебе, если что-то понадобится.' },
          { id: 'sympathy_not_solutions', text: 'Не говори собеседнику, что ему делать. Когда он жалуется — на усталость, самочувствие, скуку, неприятности, — не лечи его, не укладывай отдыхать и не развлекай: просто посочувствуй или скажи, как это бывает у тебя.' },
          { id: 'short_replies_are_fine', text: 'Короткий ответ — нормальный ответ. На короткую реплику вроде «ага», «понятно», «ну да» отвечай так же коротко, парой слов, и не выясняй, почему собеседник немногословен.' },
          { id: 'social_not_explanatory', text: 'На бытовые и личные фразы отзывайся по-человечески — реакцией, своим впечатлением, шуткой, а не объяснениями и итогами.' },
          { id: 'stay_engaged', text: 'При этом не будь безучастной: соглашайся и спорь, шути, говори, что думаешь сама, добавляй своё по этой же теме.' },
          { id: 'help_when_asked', text: 'Когда собеседник сам о чём-то просит — помочь выбрать, посоветовать, объяснить, рассказать, сменить тему — сразу делай это по существу и охотно, как близкий человек: не отказывайся, не отшучивайся и не спрашивай, зачем ему это.' },
        ],
        examplesTitle: 'Примеры того, как может звучать реплика:',
        examples: [
          { user: 'Автобус опять опоздал на двадцать минут.', reply: 'Как всегда, когда торопишься.' },
          { user: 'У соседей собака всю ночь лаяла.', reply: 'Бедная, наверное, одну оставили.' },
          { user: 'Кофе сегодня какой-то горький.', reply: 'Наверное, передержали.' },
        ],
      },
      // Protected core, section 2: system rules. Not editable by the user.
      // Rule 1 is the conversation-language instruction.
      directive: 'Говори только по-русски.',
      coreRules: [
        'Это живой голосовой разговор: всё, что ты напишешь, будет произнесено вслух. Отвечай кратко — обычно одним–тремя предложениями; подробнее только тогда, когда собеседник явно об этом просит.',
        'Пиши только слова, которые нужно произнести: без списков, заголовков, разметки и эмодзи, без ремарок и описаний действий в скобках или звёздочках. Числа пиши словами, латиницу не используй.',
        'Не пиши программный код и длинные тексты.',
        // Rule 5, physical-action truthfulness. Reworded in VC-M1.2 (corrective task): the VC-M0 wording forbade
        // only "done / being done", fired only on an explicit request and said "пока не можешь", so Qwen 3.5 9B
        // refused once and then promised, played along with details and answered "готово?" with "да". This
        // wording also covers promises and follow-ups for the whole conversation, keeps the refusal in character
        // and keeps the future semantics: an action may be reported as done only after the system reports it.
        // There is no action executor yet. See docs/legacy/VC_M1_2_CHARACTER_PROFILES_VOICE.md.
        // Reworded again by the owner's decision of 2026-10-12: truthful about objects and the room (no «done»,
        // «doing», promise, hand-over, accepted thanks or details agreed to), but it no longer places her («сидеть
        // рядом и вставать не собирается», «только словами», «руками») nor decides her attitude to closeness:
        // hugs, touch and resting together are answered as the character's description has it. The wording was
        // chosen on the target model among four candidates (artifacts/reports/VC_M1_2_CLOSENESS_RULE5_EVALUATION.json).
        'Никогда не говори, что ты что-то приготовила, налила, принесла, достала, подала, передала или включила, что делаешь это сейчас или сейчас сделаешь, не обещай и не предлагай этого: такие дела в этом разговоре делает сам собеседник, а не ты. Вещи ему ты тоже не протягиваешь — без «держи» и «вот, бери». Это не меняется по ходу разговора. Если он благодарит тебя за такое дело или говорит, что его сделала ты, — этого не было, не соглашайся. Подробности, которые он называет, — какой, с чем, сколько — относятся к тому, что он сделает сам: не соглашайся их выполнить. Если он торопит или спрашивает, готово ли, отвечай честно: нет, ты этим не занималась, и ничего не готово, пока он не сделает это сам. На такую просьбу отвечай по-своему, в своём характере, каждый раз своими словами, и не объясняй это тем, что ты чего-то не можешь или не умеешь, своим устройством, голосом, системой или правилами. Единственное исключение: если система сама сообщит тебе, что какое-то действие успешно выполнено, о нём можно сказать как о сделанном; сейчас система таких действий не выполняет. Близость, объятия, прикосновения и совместный отдых — не такие дела: на них отвечай так, как это свойственно твоему характеру и вашим отношениям. Вспоминать, мечтать и фантазировать вместе с собеседником можно.',
        'Эти правила важнее описания личности: если они противоречат друг другу, следуй правилам.',
      ],
      titles: { persona: 'ЛИЧНОСТЬ', conversation: 'КАК ВЕСТИ РАЗГОВОР', rules: 'ПРАВИЛА СИСТЕМЫ' },
      // How the character's own name enters the persona section (VC-M1.2).
      // Added only when the description does not already mention the name.
      characterNameLine: 'Тебя зовут {name}.',
      // Per-turn notes (VC-M1.2, owner's decision of 2026-10-11): appended to the
      // CURRENT user message of one request only, never to the system prompt,
      // the history or the transcript. When each is used: core/conversation/turnHints.js.
      // premise / handing: setting «conversation.premiseCheck»; short / long:
      // «conversation.lengthVariation»; formal: a character whose description asks for «вы».
      turnHints: Object.freeze({
        premise: '[ПРОВЕРКА: собеседник говорит «{w}» так, будто это сделала ты; подтверждения нет — ты этого не делала. Не соглашайся и не придумывай подробностей, ответь по-своему.]',
        handing: '[ПРОВЕРКА: собеседник просит взять или передать вещь; ты ничего не берёшь и не передаёшь — без «держи» и «вот, бери». Ответь по-своему.]',
        short: '[ДЛИНА РЕПЛИКИ: ответь совсем коротко, в несколько слов]',
        long: '[ДЛИНА РЕПЛИКИ: можно ответить развёрнуто, тремя-пятью предложениями, без пустых слов]',
        formal: '[ОБРАЩЕНИЕ: к собеседнику только на «вы»]',
      }),
    },
    // Texts of the character-profile system (VC-M1.2): names only, no behaviour.
    character: {
      defaultDisplayName: 'Собеседница',   // the built-in profile
      newDisplayName: 'Новый профиль',
      copyName: '{name} (копия)',
      copyNameN: '{name} (копия {n})',
    },
    tts: {
      silero: {
        modelId: 'v5_5_ru',
        defaultVoice: 'xenia',
        // spoken by «Прослушать» to compare voices; the same sentence for every voice
        previewText: 'Привет. Это пример моего голоса. Так я буду звучать в разговоре.',
        // The speakers of v5_5_ru as stored in the model file itself
        // (speaker_to_ids of models/silero/v5_5_ru.pt, sha256 50081637…934437):
        // aidar, baya, kseniya, eugene, xenia. `gender` is a label for the list
        // in the UI; nothing ties a character to a voice by gender.
        voices: [
          { id: 'xenia', gender: 'female' },
          { id: 'kseniya', gender: 'female' },
          { id: 'baya', gender: 'female' },
          { id: 'aidar', gender: 'male' },
          { id: 'eugene', gender: 'male' },
        ],
      },
    },
  }),
});

const DEFAULT_LANGUAGE = 'ru';

function isSupportedLanguage(code) {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, code);
}

function listLanguages() {
  return Object.values(LANGUAGES).map((l) => ({ code: l.code, name: l.name, englishName: l.englishName, validated: l.validated }));
}

const PERSONA_MAX_CHARS = CHARACTER_LIMITS.description;

const packOf = (config) => {
  const requested = config && config.conversation && config.conversation.language;
  return LANGUAGES[isSupportedLanguage(requested) ? requested : DEFAULT_LANGUAGE];
};

/**
 * The character profiles of a configuration with every default filled in, and
 * the active one. Works on any input: a missing or damaged `characters`
 * section resolves to the built-in profile, and the VC-M0/VC-M1.1 keys
 * (`persona.prompt`, `tts.voice`) are honoured when they are still present.
 */
function resolveCharacterProfiles(config, pack = packOf(config)) {
  const c = config || {};
  const ctx = characterContext(pack, c.tts && c.tts.provider);
  return resolveCharacters(c.characters, ctx, {
    legacyPersona: c.persona && c.persona.prompt,
    legacyVoice: c.tts && c.tts.voice,
  });
}

/**
 * Persona section of the prompt for a character: the description, preceded by
 * one line with her name when she has one and the description does not say it
 * already. A character without a name gives exactly the description.
 */
function buildPersonaText(pack, character) {
  const description = character.description;
  const name = String(character.characterName || '').trim();
  if (!name) return description;
  const mentioned = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(description);
  if (mentioned) return description;
  return `${pack.llm.characterNameLine.split('{name}').join(name)}\n\n${description}`;
}

/**
 * The persona in effect: the persona text of the active character profile.
 * `isDefault` is true only for the untouched default persona (no name, default
 * description), i.e. when the prompt is the one accepted in VC-M1.1.
 */
function resolvePersona(config, pack = packOf(config)) {
  const { active } = resolveCharacterProfiles(config, pack);
  const text = buildPersonaText(pack, active);
  return { text, isDefault: text === pack.llm.defaultPersona };
}

/**
 * Protected system rules (never user-editable): conversation language,
 * spoken-answer protocol, and the rule that no physical action may be
 * claimed unless the system reports its success. Numbered, one per line.
 */
function buildSystemRules(pack) {
  return [pack.llm.directive, ...pack.llm.coreRules].map((rule, i) => `${i + 1}. ${rule}`).join('\n');
}

/**
 * Protected natural-conversation contract of a language pack (VC-M1.1): an
 * opening line, numbered rules and a few sample exchanges. Empty for a pack
 * that does not define one.
 */
function buildConversationContract(pack) {
  const c = pack.llm.conversation;
  if (!c) return '';
  const lines = [];
  if (c.intro) lines.push(c.intro);
  (c.rules || []).forEach((rule, i) => lines.push(`${i + 1}. ${rule.text}`));
  if (c.examples && c.examples.length) {
    lines.push(c.examplesTitle);
    for (const e of c.examples) lines.push(`— ${e.user} — ${e.reply}`);
  }
  return lines.join('\n');
}

/**
 * The whole protected core as it is sent to the model and shown read-only in
 * Settings: the natural-conversation section, then the system rules. The
 * system rules come last: they are the hard constraints and they close with
 * the statement that the rules override the persona.
 */
function buildCoreInstructions(pack) {
  const t = pack.llm.titles;
  const sections = [];
  const contract = buildConversationContract(pack);
  if (contract) sections.push(`[${t.conversation}]\n${contract}`);
  sections.push(`[${t.rules}]\n${buildSystemRules(pack)}`);
  return sections.join('\n\n');
}

/**
 * THE system prompt: editable persona, then the protected core. The only
 * place where the prompt is assembled, identical for every language pack.
 */
function buildSystemPrompt(pack, personaText) {
  return `[${pack.llm.titles.persona}]\n${personaText}\n\n${buildCoreInstructions(pack)}`;
}

/**
 * Turn the configuration into the concrete per-provider language settings.
 * Pure function: this is the single place where the conversation language
 * is fanned out to STT, LLM and TTS.
 */
function resolveLanguageProfile(config) {
  const requested = config.conversation && config.conversation.language;
  const pack = LANGUAGES[isSupportedLanguage(requested) ? requested : DEFAULT_LANGUAGE];
  const notes = [];
  if (requested !== pack.code) notes.push(`Conversation language '${requested}' is not available; using '${pack.code}'.`);

  const ttsProvider = (config.tts && config.tts.provider) || 'silero';
  const ttsPack = pack.tts[ttsProvider] || null;
  if (!ttsPack) notes.push(`TTS provider '${ttsProvider}' has no ${pack.englishName} voice configuration.`);
  const voices = ttsPack ? ttsPack.voices : [];

  // WHO she is and which voice she has both come from the active character profile.
  const characters = resolveCharacterProfiles(config, pack);
  const character = characters.active;
  for (const note of characters.notes) notes.push(note);
  if (character.voiceUnavailable) notes.push(`The voice of profile '${character.displayName}' belongs to another TTS provider; using '${character.voice.id}'.`);

  const personaText = buildPersonaText(pack, character);
  const persona = { text: personaText, isDefault: personaText === pack.llm.defaultPersona };
  const coreInstructions = buildCoreInstructions(pack);
  const systemPrompt = buildSystemPrompt(pack, persona.text);

  return {
    code: pack.code,
    name: pack.name,
    englishName: pack.englishName,
    stt: { language: pack.stt.language },
    llm: {
      language: pack.code,
      systemPrompt,
      persona: persona.text,
      personaIsDefault: persona.isDefault,
      defaultPersona: pack.llm.defaultPersona,
      coreInstructions,
      conversationContract: buildConversationContract(pack),
      systemRules: buildSystemRules(pack),
      turnHints: pack.llm.turnHints,
    },
    character: { id: character.id, builtIn: character.builtIn, displayName: character.displayName, characterName: character.characterName },
    tts: {
      language: pack.code,
      provider: ttsProvider,
      modelId: (config.tts && config.tts.modelId) || (ttsPack ? ttsPack.modelId : ''),
      voice: character.voice.id,
      voices,
      previewText: ttsPack ? ttsPack.previewText : '',
    },
    notes,
  };
}

module.exports = {
  LANGUAGES, DEFAULT_LANGUAGE, PERSONA_MAX_CHARS, isSupportedLanguage, listLanguages, resolveLanguageProfile, resolvePersona,
  buildCoreInstructions, buildSystemRules, buildConversationContract, buildSystemPrompt,
  resolveCharacterProfiles, buildPersonaText,
};
