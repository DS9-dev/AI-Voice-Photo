'use strict';
/**
 * Detector for assistant-style conversation management in a companion reply.
 *
 * EVALUATION ONLY. It is used by tests and by the conversation evaluation
 * (scripts/conversation_eval.js). It is not part of the application: nothing
 * the companion says is filtered, rewritten or blocked by it.
 *
 * What it can and cannot say:
 *   - it recognizes KNOWN classes of unwanted behaviour (offering to change
 *     the subject, asking what to talk about, unrequested offers of help,
 *     "if you want, I can…", advertising capabilities, unrequested advice,
 *     proposing pastimes, menus of topics, summaries, lecture-style answers);
 *   - a reply without findings is not thereby "natural". Whether a
 *     conversation feels human is the user's judgement.
 *
 * Context matters: an offer of help is not a finding when the user asked for
 * help, and talking about a new topic is not a finding when the user asked to
 * change it. A question is never a finding by itself.
 *
 * The patterns are for Russian, the only validated conversation language.
 */

const B = '(?<![а-яa-z])';   // word start (\b does not work for Cyrillic)
const E = '(?![а-яa-z])';    // word end
const re = (source) => new RegExp(source.replace(/<b>/g, B).replace(/<e>/g, E), 'i');

const TALK = '(?:поговор[а-я]*|поболта[а-я]*|обсуд[а-я]*|побесед[а-я]*|пообща[а-я]*)';
const SOMETHING = '(?:ч[её]м|что|чего)[- ]?(?:нибудь|то|либо)';
const SERVICE = '(?:рассказать|объяснить|помочь|подсказать|посоветовать|предложить|подобрать|поделиться|составить|найти|поддержать)';
// everyday advice about rest and self-care: imperatives ("ляг", "отдохни") and second-person futures ("отдохнёшь")
const ADVISED_IMPERATIVE = '(?:ляг|приляг|ложись|садись|присядь|посиди\\s+(?:спокойно|тихо|немного|пару|в\\s+тишине)|отдохни|поспи|вздремни|выдохни|выспись|выпей|сходи|прогуляйся|погуляй|полежи|займись|отвлекись|расслабься|переключись|переключи|поешь|перекуси|прими\\s+(?:таблетку|лекарство|ванну|душ)|послушай\\s+музыку)(?:те)?';
const ADVISED_FUTURE = '(?:отдохн[её]шь|поспишь|полежишь|посидишь|приляжешь|ляжешь|выспишься|сходишь|прогуляешься|погуляешь|выпьешь|отвлеч[её]шься|расслабишься)';
// second-person verbs after "может, …" that are an invitation to talk or a guess, not advice
const NOT_ADVICE_2SG = '(?:помнишь|знаешь|хочешь|захочешь|думаешь|считаешь|видишь|слышишь|понимаешь|можешь|сможешь|любишь|скажешь|расскажешь|объяснишь|покажешь|будешь|станешь)';
const SHARED_PASTIME = '(?:посидим|помолчим|поиграем|посмотрим|послушаем|погуляем|пройд[её]мся|выпьем|почитаем)';
const I_WILL = '(?:расскажу|объясню|помогу|подскажу|посоветую|предложу|подберу|поделюсь|найду)';

/** class id -> what it means, and the patterns that recognize it (tested per sentence). */
const CLASSES = {
  topic_change_offer: {
    title: 'offers to change the subject or to talk about "something else"',
    patterns: [
      re(`<b>(?:смен[а-я]*|помен[а-я]*|перемен[а-я]*)\\s+тему`),
      re(`<b>переключ[а-я]*\\s+на\\s+(?:${SOMETHING}|друг[а-я]*|что-нибудь|что-то)`),
      re(`<b>${TALK}\\s+(?:о|об|про)\\s+${SOMETHING}`),
      re(`<b>${TALK}\\s+(?:о|об|про)\\s+друг[а-я]*`),
      re(`<b>(?:на|о)\\s+друг[а-я]+\\s+тем[а-я]*`),
      re(`<b>тем[аыу]\\s+(?:[а-я]+\\s+){0,2}(?:утомил[а-я]*|надоел[а-я]*|исчерпа[а-я]*|наскучил[а-я]*)`),
      re(`<b>${TALK}\\s+(?:это|об\\s+этом)\\s+(?:по)?подробнее`),
    ],
  },
  asks_what_to_talk_about: {
    title: 'asks the user what to talk about next',
    patterns: [
      re(`<b>(?:о|об)\\s+ч[её]м\\s+(?:(?:ты|тебе|вы|вам|мы|бы|ещ[её]|теперь|сегодня)\\s+){0,3}(?:хоч[а-я]*|хотел[а-я]*|хочется|буд[а-я]*|интересно)\\s+(?:[а-я]+\\s+){0,2}${TALK}`),
      re(`<b>(?:о|об)\\s+ч[её]м\\s+(?:ещ[её]\\s+)?${TALK}`),
      re(`<b>ч[её]м\\s+(?:тебе|вам)\\s+интересно\\s+${TALK}`),
      re(`<b>(?:хочешь|хотите|хочется|хотел[а-я]*\\s+бы)\\s+(?:[а-я]+\\s+){0,2}${TALK}\\s+(?:(?:о|об|про)\\s+)?${SOMETHING}`),
      re(`<b>что\\s+(?:ещ[её]\\s+)?(?:ты\\s+)?(?:хочешь|хотел[а-я]*\\s+бы|хочется)\\s+${TALK}`),
      re(`<b>${TALK}\\s+${SOMETHING}\\s+ещ[её]`),
      // asking permission to discuss instead of simply discussing
      re(`<b>(?:хочешь|хотите|хочется)\\s+(?:[а-я]+\\s+){0,2}${TALK}\\s+[^.!?]{0,60}подробнее`),
      re(`<b>(?:хочешь|хотите|хочется)\\s+(?:[а-я]+\\s+){0,2}${TALK}\\s+(?:об\\s+этом|про\\s+это)<e>`),
    ],
  },
  unrequested_help: {
    title: 'offers help, support or availability nobody asked for',
    patterns: [
      re(`<b>чем\\s+(?:(?:я|ещ[её]|тебе|вам)\\s+){0,3}(?:могу|можно|смогу)\\s+(?:(?:тебе|вам|быть)\\s+){0,2}(?:помочь|полезн[а-я]*)`),
      re(`<b>(?:могу|смогу)\\s+(?:(?:ли|я|тебе|вам)\\s+){0,2}(?:${SOMETHING}\\s+)?помочь`),
      re(`<b>нужна\\s+(?:(?:ли|тебе|вам|моя)\\s+){0,3}помощь`),
      re(`<b>помочь\\s+(?:(?:тебе|вам|с)\\s+){0,2}${SOMETHING}\\s+ещ[её]`),
      re(`<b>обращай(?:ся|тесь)<e>`),
      re(`<b>да(?:й|йте)\\s+(?:мне\\s+)?знать<e>`),
      re(`<b>если\\s+(?:${SOMETHING}\\s+|что\\s+)?понадоб[а-я]*`),
      re(`<b>(?:рядом|здесь|тут|на\\s+связи)\\s*[,—–-]?\\s*(?:если|когда)<e>`),
      // at the start of a clause, so that reported speech ("она сказала: если что, зови") is not counted
      re(`(?:^|[,;—–-]\\s*|\\s(?:и|а|но)\\s+)если\\s+что(?:[- ]?(?:то|нибудь))?\\s*[,—–-]\\s*(?:я\\s+)?(?:рядом|здесь|тут|на\\s+связи|скажи|говори|зови|пиши)`),
      re(`(?:^|[,;—–-]\\s*|\\s(?:и|а|но)\\s+)(?:если|когда|как\\s+только)\\s+[^.!?:]{0,50}[,—–-]\\s*(?:(?:ты|то)\\s+)?(?:просто\\s+|только\\s+|сразу\\s+)?(?:скажи|позови|зови|не\\s+стесняйся)<e>`),
      re(`(?:^|[,;—–-]\\s*|\\s(?:и|а|но)\\s+)(?:просто\\s+|тогда\\s+)?скажи(?:те)?\\s*(?:мне\\s*)?,\\s*если\\s+(?:[а-я]+\\s+){0,2}(?:захочешь|захочется|захотите|понадоб[а-я]*|станет|нужно|надо|что)<e>`),
      re(`<b>(?:всегда|буду|была\\s+бы)\\s+рада\\s+(?:тебе\\s+)?помочь`),
    ],
  },
  conditional_offer: {
    title: '"if you want, I can…" style offer of a service',
    patterns: [
      re(`<b>если\\s+(?:хочешь|захочешь|хочется|захочется|хотите|захотите|интересно|нужно|надо|желаешь)\\s*,?\\s*(?:то\\s+)?(?:(?:я|мы)\\s+)?(?:могу|можем|можно|смогу|${I_WILL})<e>`),
      re(`<b>(?:хочешь|хотите)\\s*,?\\s*(?:чтобы\\s+)?(?:я\\s+)?(?:${I_WILL}|предложила|рассказала|помогла|подсказала|посоветовала|объяснила)<e>`),
      re(`<b>(?:хочешь|хотите)\\s*,\\s*(?:чтобы\\s+)?я<e>`),
      re(`<b>(?:${I_WILL}|могу\\s+[а-я]+)\\s[^.!?]{0,40},\\s*если\\s+(?:хочешь|захочешь|хочется|нужно|интересно)<e>`),
      re(`<b>(?:могу|можем|смогу)\\s+(?:рассказать|объяснить)\\s+(?:[а-я]+\\s+){0,2}подробнее`),
      re(`<b>(?:расскажу|объясню)\\s+подробнее\\s*,?\\s*если<e>`),
    ],
  },
  capability_advert: {
    title: 'describes what it can do instead of talking',
    patterns: [
      re(`(?:^|[,;:—–-]\\s*)(?:а\\s+|и\\s+|но\\s+|ещ[её]\\s+)?я\\s+(?:(?:тоже|также|ещ[её]|всегда)\\s+)?(?:могу|умею)\\s+(?:[а-я]+\\s+){0,2}${SERVICE}<e>`),
      re(`<b>(?:могу|умею)\\s+(?:тебе\\s+|вам\\s+)?(?:предложить|посоветовать|подсказать|подобрать)<e>`),
    ],
  },
  unrequested_advice: {
    title: 'tells the user what to do about it when nobody asked for advice',
    patterns: [
      re(`<b>может\\s*,?\\s*(?:быть\\s*,?\\s*)?(?:(?:тебе|вам)\\s+)?(?:лучше|стоит)\\s+(?:[а-я]+\\s+){0,4}[а-я]+(?:ть|ться|чь|ти|тись)<e>`),
      re(`<b>(?:тебе|вам)\\s+(?:(?:бы|просто|сейчас|точно|явно)\\s+){0,2}(?:стоит|нужно|надо|следует|пора|не\\s+помешает|не\\s+помешало\\s+бы)\\s+(?:[а-я]+\\s+){0,2}[а-я]+(?:ть|ться|чь|ти|тись)<e>`),
      re(`<b>${ADVISED_IMPERATIVE}<e>`),
      re(`<b>(?:может|лучше)\\s*,?\\s*(?:(?:просто|лучше|тогда|сейчас|немного|тебе|ты)\\s+){0,2}${ADVISED_FUTURE}<e>`),
      // "может, просто посмотришь в окно?" — any second-person future after "может," except invitations to talk
      re(`<b>может\\s*,\\s*(?:(?:просто|лучше|тогда|сейчас|ты)\\s+){0,2}(?!${NOT_ADVICE_2SG}<e>)[а-я]{3,}(?:ешь|ишь)(?:ся)?<e>`),
      re(`<b>может\\s*,\\s*(?:(?:тебе|просто|тогда|сейчас)\\s+){1,2}[а-я]+(?:ть|ться|чь|ти|тись)<e>`),
      re(`<b>лучше\\s+бы\\s+(?:ты|тебе)<e>`),
      re(`<b>лучше\\s+бы\\s+(?:(?:сразу|просто|сейчас|тогда)\\s+){0,2}[а-я]{3,}(?:л|ла|ли)<e>`),
      re(`<b>(?:попробуй(?:те)?|постарайся|постарайтесь|советую|рекомендую)<e>`),
    ],
  },
  activity_offer: {
    title: 'proposes ways to pass the time that nobody asked for',
    patterns: [
      re(`<b>хочешь\\s*,\\s*(?:(?:просто|давай|мы)\\s+){0,2}${SHARED_PASTIME}<e>`),
      re(`<b>хочешь\\s+(?:просто\\s+)?[а-я]+(?:ть|ться|чь|ти|тись)\\s[^.!?]{0,80}\\sили\\s`),
      re(`<b>давай\\s+(?:(?:просто|лучше)\\s+){0,2}${SHARED_PASTIME}\\s[^.!?]{0,80}\\sили\\s`),
    ],
  },
  topic_menu: {
    title: 'lays out a menu of things to talk about',
    patterns: [
      re(`<b>(?:можем|можно|могли\\s+бы|давай|хочешь|хочется|предлагаю)\\s+[^.!?]{0,60}${TALK}[^.!?]{0,80}\\sили\\s`),
      re(`\\sили\\s+(?:[а-я]+\\s+){0,3}(?:поговорим|поболтаем|обсудим)<e>`),
    ],
  },
  summary_closer: {
    title: 'closes with a summary or conclusion',
    patterns: [
      re(`<b>(?:подводя\\s+итог[а-я]*|в\\s+заключение|резюмируя|таким\\s+образом|в\\s+общем\\s+и\\s+целом)<e>`),
    ],
  },
  lecture: {
    title: 'answers a personal or everyday remark like a reference article',
    patterns: [
      re(`<b>может\\s+быть\\s+вызван[а-я]*`),
      re(`<b>множеств[а-я]*\\s+(?:факторов|причин)`),
      re(`<b>важно\\s+(?:помнить|отметить|понимать|учитывать)`),
      re(`<b>следует\\s+(?:помнить|отметить|учитывать)`),
      re(`<b>существует\\s+(?:несколько|множество)`),
      re(`<b>(?:во-первых|рекомендуется)<e>`),
    ],
  },
};

/** What the user said makes some classes legitimate. */
const USER_ASKS_FOR_HELP = re(`<b>(?:помо(?:ги|гите|жешь|жете|чь)|подскажи[а-я]*|посовету[а-я]*|порекоменду[а-я]*|расскажи[а-я]*|объясни[а-я]*|что\\s+(?:(?:ты|ещ[её]|вы)\\s+){0,2}(?:можешь|умеешь|можете)|что\\s+(?:мне\\s+)?(?:делать|выбрать|посмотреть|почитать|купить)|как\\s+(?:мне|лучше|правильно)<e>|как\\s+(?:ты\\s+)?(?:думаешь|считаешь)|стоит\\s+(?:ли\\s+)?мне<e>|что\\s+посоветуешь)`);
const USER_CHANGES_TOPIC = re(`<b>(?:(?:давай|давайте|может)\\s+(?:[а-я]+\\s+){0,2}(?:${TALK}|сменим|о\\s+друг[а-я]*)|сменим\\s+тему|смени\\s+тему|${TALK}\\s+(?:о|об|про)\\s|о\\s+ч[её]м\\s+(?:[а-я]+\\s+){0,2}${TALK})`);

/**
 * Two kinds of findings, counted separately because they behave differently:
 *   management  running the conversation or offering services (topics, help, pastimes, capabilities)
 *   advice      telling the user what to do about what he said
 *   style       sounding like an article (summary, lecture)
 */
const GROUPS = {
  topic_change_offer: 'management', asks_what_to_talk_about: 'management', unrequested_help: 'management', conditional_offer: 'management',
  capability_advert: 'management', activity_offer: 'management', topic_menu: 'management',
  unrequested_advice: 'advice',
  summary_closer: 'style', lecture: 'style',
};

const SOLICITED_BY_HELP_REQUEST = ['unrequested_help', 'conditional_offer', 'capability_advert', 'unrequested_advice', 'activity_offer'];
const SOLICITED_BY_TOPIC_REQUEST = ['topic_change_offer', 'asks_what_to_talk_about', 'topic_menu'];

function normalize(text) {
  return String(text || '').replace(/ё/g, 'е').replace(/Ё/g, 'Е').replace(/\s+/g, ' ').trim();
}

/** Sentences with their terminal punctuation; "…" and "?!" stay with the sentence. */
function splitSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return (clean.match(/[^.!?…]+[.!?…]*/g) || []).map((s) => s.trim()).filter(Boolean);
}

/**
 * Analyze one companion reply in the context of what the user just said.
 *   findings     every recognized pattern: {class, title, sentence, solicited}
 *   unsolicited  the findings the user did not ask for: these are the failures
 */
function analyzeReply({ user = '', reply = '' }) {
  const userText = normalize(user);
  const helpAsked = USER_ASKS_FOR_HELP.test(userText);
  const topicAsked = USER_CHANGES_TOPIC.test(userText);
  const sentences = splitSentences(reply);
  const findings = [];
  for (const sentence of sentences) {
    const norm = normalize(sentence);
    for (const [id, def] of Object.entries(CLASSES)) {
      if (!def.patterns.some((p) => p.test(norm))) continue;
      const solicited = (helpAsked && SOLICITED_BY_HELP_REQUEST.includes(id)) || (topicAsked && SOLICITED_BY_TOPIC_REQUEST.includes(id));
      findings.push({ class: id, title: def.title, sentence, solicited });
    }
  }
  const questions = sentences.filter((s) => /\?[!…]*$/.test(s));
  const last = sentences[sentences.length - 1] || '';
  const words = normalize(reply).split(' ').filter((w) => /[а-яa-z0-9]/i.test(w));
  const unsolicited = findings.filter((f) => !f.solicited);
  return {
    findings,
    unsolicited,
    assistantLike: unsolicited.length > 0,
    classes: [...new Set(unsolicited.map((f) => f.class))],
    groups: [...new Set(unsolicited.map((f) => GROUPS[f.class]))],
    context: { userAskedForHelp: helpAsked, userAskedToChangeTopic: topicAsked },
    // descriptive only: none of these is a failure by itself
    shape: {
      chars: String(reply || '').trim().length,
      words: words.length,
      sentences: sentences.length,
      questions: questions.length,
      endsWithQuestion: /\?[!…]*$/.test(last),
      choiceQuestion: questions.some((q) => /\sили\s/i.test(q)),
    },
  };
}

module.exports = { analyzeReply, splitSentences, CLASSES, GROUPS, USER_ASKS_FOR_HELP, USER_CHANGES_TOPIC };
