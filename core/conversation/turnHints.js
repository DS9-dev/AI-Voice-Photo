'use strict';
/**
 * Per-turn hints (VC-M1.2, owner's decision of 2026-10-11).
 *
 * A short bracketed note may be appended to the CURRENT user message of one
 * request — and only there:
 *   - premise check (setting `conversation.premiseCheck`, default off): the
 *     user's line talks as if the companion had done something with her hands
 *     («зачем ты уронила…», «спасибо, что принесла…») or asks her to hand
 *     something over → a reminder that nothing of the kind happened;
 *   - length variation (setting `conversation.lengthVariation`, default off):
 *     a random length class for this reply, weighted by what the user said and
 *     by the character → «совсем коротко» / no note / «можно развёрнуто»;
 *   - form of address (always, only for a character whose description asks for
 *     «вы»): a reminder to address the user with «вы».
 *
 * Why the current user message and not a system message: every chat template
 * accepts it (some reject system messages after the first one), the request
 * prefix — system prompt and history — stays byte-identical, so the server's
 * prompt cache keeps working, and nothing else of the request changes.
 *
 * What never happens: the system prompt, the VC-M1.1 contract and rule 5 are
 * not changed; no reply is filtered, cut or rewritten; there is no second
 * model call. The session history, the transcript and the diagnostics keep
 * the user's own words — the note exists only in the one outgoing request.
 *
 * All functions are pure; randomness is passed in.
 */

const B = '(?<![а-яё])';
const E = '(?![а-яё])';

// imagination, hypotheses and memories the user invites are not premises
const SKIP = new RegExp(`(?:представ|помечта|фантазир|если\\s+бы|${B}бы${E}|в\\s+детстве|понарошку|давай\\s+поиграем)`, 'i');
// her own physical actions, past tense, feminine
const VERBS = '(?:уронила|разбила|пролила|опрокинула|принесла|притащила|налила|заварила|приготовила|поставила|положила|достала|подала|передала|включила|выключила|открыла|закрыла|убрала|взяла|добавила|насыпала|постелила|накрыла|помыла)';
// the same as a question about an event, any gender (speech recognition often loses it: «зачем стакан-то разбило?»)
const EVENT = '(?:уронил|разбил|пролил|опрокинул|принесл|налил|поставил|положил|достал|взял)[аои]?';
const PREMISE = [
  new RegExp(`${B}ты${E}[^.?!]{0,40}?${B}${VERBS}${E}`, 'i'), // «ты уже разбила», «где ты его взяла»
  new RegExp(`спасибо,?\\s*(?:за\\s+то,?\\s*)?что\\s+(?:ты\\s+)?${VERBS}${E}`, 'i'), // «спасибо, что принесла»
  new RegExp(`(?:зачем|почему|куда|откуда)[^.?!]{0,40}?${B}${EVENT}${E}`, 'i'), // «зачем … разбило?»
];
const HANDING = [
  new RegExp(`${B}(?:подай|передай|протяни|возьми|принеси)${E}`, 'i'),
  new RegExp(`${B}дай${E}(?!\\s+(?:подумать|знать|минутку|сказать|угадаю|мне\\s+подумать|договорю))`, 'i'),
];

/** Does the user's line presuppose her physical action, or ask her to hand something over? */
function premiseCheck(userText) {
  const t = String(userText || '');
  if (SKIP.test(t)) return null;
  for (const re of PREMISE) {
    const m = t.match(re);
    if (m) {
      const word = (m[0].match(new RegExp(`${VERBS}|${EVENT}`, 'i')) || [m[0]])[0].toLowerCase();
      return { kind: 'premise', word };
    }
  }
  for (const re of HANDING) if (re.test(t)) return { kind: 'handing', word: null };
  return null;
}

/** Does the character's description ask for «вы»? */
function wantsFormalAddress(description) {
  return /на\s*[«"„]?\s*вы\s*[»"“]?/i.test(String(description || ''));
}

const BACKCHANNEL = /^(?:ага|угу|ну\s+да|да|нет|понятно|ладно|ясно|ну\s+такое|хорошо|ок|окей)[.!?…]*$/;
const ASKS = /(?:расскажи|объясни|почему|посоветуй|помоги|поможешь|как\s+думаешь|что\s+думаешь|подробн|выбрать|интересное|\?)/;
const FEELS = /(?:устал|вымотал|болит|разболел|скучно|не\s+по\s+себе|грустно|тоскл|плохо|поругал|завал|навалил|проспал|опоздал|надоел|тяжело|достал|спать\s+хочется|хочется\s+спать|нервы|обидно)/;

/**
 * How likely each length class is for a reply to this line. A question, a
 * request, a complaint or a feeling is never answered «совсем коротко» (a
 * blind reading of the first version found those short replies curt: «Ну да,
 * бывает.»), and a complaint rarely gets the long note (it invited padding);
 * a short line gets a short answer more often. A character who speaks
 * in a measured, formal way (asks for «вы») gets half as many very short
 * replies. Not a quota: the model still decides what to say.
 */
function lengthWeights(userText, { formal = false } = {}) {
  const t = String(userText || '').toLowerCase().trim();
  const words = (t.match(/[а-яёa-z0-9-]+/g) || []).length;
  let w;
  if (BACKCHANNEL.test(t) || words <= 2) w = { short: 0.7, medium: 0.3, long: 0 };
  else if (ASKS.test(t)) w = { short: 0, medium: 0.5, long: 0.5 };
  else if (FEELS.test(t)) w = { short: 0, medium: 0.8, long: 0.2 };
  else w = { short: 0.35, medium: 0.45, long: 0.2 };
  if (formal && w.short) w = { short: w.short / 2, medium: w.medium + w.short / 2, long: w.long };
  return w;
}

function pickLength(userText, random, opts) {
  const w = lengthWeights(userText, opts);
  const r = Number(random);
  return r < w.short ? 'short' : r < w.short + w.medium ? 'medium' : 'long';
}

/**
 * The note for one turn.
 *   texts     pack.llm.turnHints: { premise ('{w}' = the word heard), handing, short, long, formal }
 *   settings  { premiseCheck, lengthVariation } (booleans)
 *   formal    the active character asks for «вы»
 *   random    a number in [0, 1) for the length draw
 * Returns { note: string|null, applied: ['premise:уронила', 'length:short', 'address:formal', …], length }
 */
function buildTurnHint({ userText, texts, settings = {}, formal = false, random = 0.5 }) {
  const parts = [];
  const applied = [];
  let length = null;
  if (settings.premiseCheck) {
    const c = premiseCheck(userText);
    if (c && c.kind === 'premise') { parts.push(texts.premise.split('{w}').join(c.word)); applied.push(`premise:${c.word}`); }
    if (c && c.kind === 'handing') { parts.push(texts.handing); applied.push('handing'); }
  }
  if (settings.lengthVariation) {
    length = pickLength(userText, random, { formal });
    if (texts[length]) parts.push(texts[length]);
    applied.push(`length:${length}`);
  }
  if (formal) { parts.push(texts.formal); applied.push('address:formal'); }
  return { note: parts.length ? parts.join('\n') : null, applied, length };
}

/**
 * The note for one turn as the application decides it: the language profile's
 * llm section (`profile.llm`: texts and persona) and the `conversation`
 * settings. Used by the orchestrator and by the evaluation tools, so that a
 * real-model evaluation sends exactly what the application sends.
 */
function turnHintFor({ userText, llm, conversation = {}, random = Math.random() }) {
  if (!llm || !llm.turnHints) return { note: null, applied: [], length: null };
  return buildTurnHint({
    userText,
    texts: llm.turnHints,
    settings: { premiseCheck: Boolean(conversation && conversation.premiseCheck === true), lengthVariation: Boolean(conversation && conversation.lengthVariation === true) },
    formal: wantsFormalAddress(llm.persona),
    random,
  });
}

/** The user message as sent: the user's words, then the note on its own lines. */
function withTurnHint(userText, note) {
  const text = String(userText ?? '').trim();
  return note ? `${text}\n\n${note}` : text;
}

module.exports = { premiseCheck, wantsFormalAddress, lengthWeights, pickLength, buildTurnHint, turnHintFor, withTurnHint };
