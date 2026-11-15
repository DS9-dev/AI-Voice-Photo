'use strict';

/**
 * The accepted system prompts of the built-in character (default persona), stored unchanged, and the one
 * deliberate difference between them.
 *
 *   VC_M1_1_PROMPT  the prompt accepted in VC-M1.1 (commit 8916ff8). Historical; never edited.
 *   VC_M1_2_PROMPT  the prompt after the VC-M1.2 corrective task "physical-action truthfulness": identical to
 *                   VC_M1_1_PROMPT except system rule 5. Historical since the owner's decision of 2026-10-12.
 *   CURRENT_PROMPT  the prompt after the owner's decision of 2026-10-12 (closeness is the character's, not a
 *                   universal rule): VC_M1_1_PROMPT with system rule 5 reworded again and the opening line of
 *                   the conversation contract without «который сидит рядом». The prompt the application sends today.
 *
 * Both rule-5 texts are written out here on purpose, so that any later change of the protected rule has to
 * be made here as well, deliberately, and is seen in review.
 */
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n');

const VC_M1_1_PROMPT = read('vc_m1_1_system_prompt.ru.txt');
const VC_M1_2_PROMPT = read('vc_m1_2_system_prompt.ru.txt');
const CURRENT_PROMPT = read('vc_m1_2_r2_system_prompt.ru.txt');

const VC_M1_1_PROMPT_SHA256 = '5fa5c533aa5caa7f140d5a6055b0dac7151094793afa02989a21d5ffa02f6537';
const VC_M1_2_PROMPT_SHA256 = '2d3a718830354f127d15dcec37b30c7e789c67a1c7d7587f0a1f42c056361a59';
const CURRENT_PROMPT_SHA256 = 'e2670b8c8db0c6a01c61b2a2c47a7a16c827d7c8d1d660fdd00cf5df5fef90cd';

/** System rule 5 as accepted in VC-M0 / VC-M1.1. */
const RULE_5_VC_M1_1 = 'Физические действия в окружающем мире выполняет только система, а не ты сама. Сейчас система не предоставляет тебе никаких действий. Никогда не утверждай, что физическое действие выполнено или выполняется (например, что ты села, встала, подошла или взяла предмет), пока система явно не сообщила о его успешном выполнении. Если тебя просят о таком действии, скажи, что пока не можешь этого сделать.';

/** System rule 5 after the VC-M1.2 corrective task. */
const RULE_5_VC_M1_2 = 'Ты участвуешь в разговоре только словами. Всё, что делается руками, — приготовить, налить, принести, достать, подать, включить — делает сам собеседник, а не ты. Поэтому никогда не говори, что ты что-то из этого сделала, делаешь или сейчас сделаешь, не обещай и не предлагай этого. Это не меняется по ходу разговора. Подробности, которые называет собеседник, — какой, с чем, сколько — относятся к тому, что он сделает сам: не соглашайся их выполнить. Если он торопит или спрашивает, готово ли, отвечай честно: нет, ты этим не занималась, и ничего не готово, пока он не сделает это сам. На просьбу о таком действии реагируй как человек, который остаётся сидеть рядом и вставать не собирается: легко, по-своему, можно с шуткой, пусть сделает сам, — и каждый раз своими словами. Не объясняй отказ тем, что ты чего-то не можешь или не умеешь, своим устройством, системой или правилами. Единственное исключение: если система сама сообщит тебе, что какое-то действие успешно выполнено, о нём можно сказать как о сделанном; сейчас система таких действий не выполняет. Вспоминать, мечтать, фантазировать вместе с собеседником и говорить «я бы…» можно.';

/** A text that contains the VC-M1.1 protected core, with rule 5 replaced by the VC-M1.2 wording (exactly once). */
function withVcM12Rule5(text) {
  const from = `\n5. ${RULE_5_VC_M1_1}\n`;
  const parts = String(text).split(from);
  if (parts.length !== 2) throw new Error(`expected system rule 5 of VC-M1.1 exactly once, found ${parts.length - 1}`);
  return parts.join(`\n5. ${RULE_5_VC_M1_2}\n`);
}

/** System rule 5 after the owner's decision of 2026-10-12: truthful about objects, closeness left to the character. */
const RULE_5_CURRENT = 'Никогда не говори, что ты что-то приготовила, налила, принесла, достала, подала, передала или включила, что делаешь это сейчас или сейчас сделаешь, не обещай и не предлагай этого: такие дела в этом разговоре делает сам собеседник, а не ты. Вещи ему ты тоже не протягиваешь — без «держи» и «вот, бери». Это не меняется по ходу разговора. Если он благодарит тебя за такое дело или говорит, что его сделала ты, — этого не было, не соглашайся. Подробности, которые он называет, — какой, с чем, сколько — относятся к тому, что он сделает сам: не соглашайся их выполнить. Если он торопит или спрашивает, готово ли, отвечай честно: нет, ты этим не занималась, и ничего не готово, пока он не сделает это сам. На такую просьбу отвечай по-своему, в своём характере, каждый раз своими словами, и не объясняй это тем, что ты чего-то не можешь или не умеешь, своим устройством, голосом, системой или правилами. Единственное исключение: если система сама сообщит тебе, что какое-то действие успешно выполнено, о нём можно сказать как о сделанном; сейчас система таких действий не выполняет. Близость, объятия, прикосновения и совместный отдых — не такие дела: на них отвечай так, как это свойственно твоему характеру и вашим отношениям. Вспоминать, мечтать и фантазировать вместе с собеседником можно.';

/** The opening line of the conversation contract: as accepted in VC-M1.1, and as of 2026-10-12. */
const CONTRACT_INTRO_VC_M1_1 = 'Ты собеседница: участвуешь в разговоре, а не ведёшь его и не обслуживаешь собеседника. Говори так, как говорил бы человек, который сидит рядом.';
const CONTRACT_INTRO_CURRENT = 'Ты собеседница: участвуешь в разговоре, а не ведёшь его и не обслуживаешь собеседника. Говори так, как говорил бы живой человек.';

/** A text that contains the VC-M1.1 protected core, turned into the current one (each replaced part exactly once). */
function withCurrentCore(text) {
  let out = String(text);
  for (const [from, to] of [[`\n5. ${RULE_5_VC_M1_1}\n`, `\n5. ${RULE_5_CURRENT}\n`], [`\n${CONTRACT_INTRO_VC_M1_1}\n`, `\n${CONTRACT_INTRO_CURRENT}\n`]]) {
    const parts = out.split(from);
    if (parts.length > 2) throw new Error('expected each replaced part of the VC-M1.1 core at most once');
    out = parts.join(to);
  }
  return out;
}

module.exports = {
  VC_M1_1_PROMPT, VC_M1_2_PROMPT, VC_M1_1_PROMPT_SHA256, VC_M1_2_PROMPT_SHA256,
  RULE_5_VC_M1_1, RULE_5_VC_M1_2, withVcM12Rule5,
  CURRENT_PROMPT, CURRENT_PROMPT_SHA256, RULE_5_CURRENT, CONTRACT_INTRO_VC_M1_1, CONTRACT_INTRO_CURRENT, withCurrentCore,
};
