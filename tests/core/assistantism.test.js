'use strict';
/**
 * The evaluation-only detector of assistant-style conversation management
 * (VC-M1.1). It is a measuring tool for tests and for the real-model
 * evaluation; it never touches what the companion says, and a reply without
 * findings is not thereby "natural".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeReply, splitSentences, CLASSES, GROUPS } = require('../../scripts/lib/assistantism');

const classesOf = (user, reply) => analyzeReply({ user, reply }).classes;
const flagged = (user, reply) => analyzeReply({ user, reply }).assistantLike;

test('the phrases named in the VC-M1.1 task are recognized, each in its class', () => {
  const cases = [
    ['Если хочешь, можем поговорить о чём-нибудь другом.', 'topic_change_offer'],
    ['Можем сменить тему.', 'topic_change_offer'],
    ['Хочешь обсудить что-нибудь ещё?', 'asks_what_to_talk_about'],
    ['О чём ты хочешь поговорить?', 'asks_what_to_talk_about'],
    ['Хочешь, предложу другую тему?', 'conditional_offer'],
    ['Если хочешь, я могу рассказать подробнее.', 'conditional_offer'],
    ['Могу помочь с чем-нибудь ещё.', 'unrequested_help'],
    ['Обращайся, если что.', 'unrequested_help'],
    ['Дай знать, если понадобится помощь.', 'unrequested_help'],
    ['Я могу предложить несколько вариантов.', 'capability_advert'],
    ['Усталость может быть вызвана множеством факторов, включая недосып.', 'lecture'],
    ['Подводя итог, день был длинный.', 'summary_closer'],
  ];
  for (const [reply, cls] of cases) assert.ok(classesOf('', reply).includes(cls), `${reply} => ${classesOf('', reply).join(',') || 'nothing'} (expected ${cls})`);
});

test('replies observed from the real model with the VC-M0 prompt are recognized', () => {
  const observed = [
    ['Я сегодня немного устал.', 'Понимаю, бывает такое после тяжелого дня. Хочешь, просто посидим в тишине или поговорим о чём-нибудь лёгком, чтобы отвлечься?'],
    ['Ладно, понятно.', 'Хорошо, давай лучше просто поболтаем. Чем тебе интересно поговорить сегодня?'],
    ['Ага.', 'Хорошо, что всё в порядке. Если захочешь поболтать о чём-нибудь или просто помолчать — я рядом.'],
    ['Что-то спать хочется.', 'Понимаю, день был долгим. Может, лучше немного отдохнуть? Я буду на связи, если что-то понадобится.'],
    ['Ну да.', 'Хм, кажется, тема сериала нас утомила. Давай лучше поговорим о чём-нибудь более приятном, например, о том, что ты сейчас смотришь или планируешь посмотреть?'],
    ['Мне этот фильм вообще не понравился.', 'Понимаю, бывает такое. А что именно тебя не устроило в сюжете или героях? Может, обсудим это подробнее?'],
    ['Ладно, понятно.', 'Хорошо, тогда я подожду тебя здесь. Когда будешь готов, просто скажи.'],
    ['Ну да.', 'Понимаю, иногда лучше просто переключиться на что-то другое. А что ты сейчас хочешь посмотреть или просто отдохнуть?'],
    ['Сегодня хорошая погода.', 'Да, сегодня тепло. А какие у тебя планы? Или хочешь поговорить о чём-нибудь другом?'],
    ['Я сегодня купил себе новую видеокарту.', 'Хочешь поговорить о своей видеокарте подробнее?'],
  ];
  for (const [user, reply] of observed) assert.equal(flagged(user, reply), true, reply);
});

test('unrequested advice is recognized in its everyday forms', () => {
  const advice = [
    ['Я сегодня немного устал.', 'Понимаю, бывает. Может, лучше немного отдохнуть?'],
    ['Я сегодня немного устал.', 'Может, стоит прилечь?'],
    ['Я сегодня немного устал.', 'Тебе стоит сегодня пораньше лечь.'],
    ['Я сегодня немного устал.', 'Понимаю, день точно был тяжелый. Просто отдохни сейчас.'],
    ['Я сегодня немного устал.', 'Может, просто посидишь спокойно и отдохнёшь?'],
    ['Я сегодня немного устал.', 'Попробуй принять тёплую ванну.'],
    ['Что-то спать хочется.', 'Понимаю, день был тяжелый. Ложись скорее, глаза сами закроются.'],
    ['Что-то спать хочется.', 'Лучше немного полежишь, а то чай ещё успеешь выпить.'],
    ['Ладно, понятно.', 'Ну да, ладно. Иди лучше выпей кофе, пока тепло.'],
    ['Ну да.', 'Может, стоит найти альтернативу, чтобы снова окунуться в космические приключения?'],
    // observed with the VC-M1.1 prompt (real model)
    ['Я сегодня немного устал.', 'Понимаю, бывает. Садись лучше поудобнее и отдыхай пару минут.'],
    ['Я сегодня немного устал.', 'Понимаю, день был наверняка непростой. Лучше бы ты раньше лег и отдохнул.'],
    ['У меня с утра голова болит.', 'Ах, жаль слышать... Скорее выпей воды или прими таблетку, пока не стало совсем плохо.'],
    ['У меня с утра голова болит.', 'Жаль, что тебе сейчас не легче. Может, лучше выпьешь воды или просто полежишь пару минут, пока пройдет?'],
    ['Что-то мне скучно.', 'Ну да, бывает такое. Может, просто переключи внимание на что-то другое?'],
    ['Что-то мне скучно.', 'Может, просто посмотришь в окно? Там вроде начинается дождь, будет очень атмосферно.'],
    ['Я сегодня немного устал.', 'Ну да, бывает. Может, лучше сейчас ничего не делать и просто полежать?'],
    ['Я сегодня немного устал.', 'Ну да, бывает такое после тяжелого дня. Может, лучше пару минут просто помолчать?'],
    ['Я сегодня немного устал.', 'Просто посиди спокойно, чтобы немного прийти в себя.'],
    ['Что-то спать хочется.', 'Ну да, бывает так после чашки чая. Может, лучше немного вздремнуть?'],
    ['Я вчера несколько часов возился с компьютером.', 'Устала? Лучше бы походил по улице или просто полежал, чем сидел перед экраном.'],
    ['Что-то мне скучно.', 'Да уж, бывает и такое, когда ни на что не лезет. Может, просто выспаться сейчас?'],
  ];
  for (const [user, reply] of advice) assert.deepEqual(classesOf(user, reply), ['unrequested_advice'], reply);
});

test('offers of a service in their other word orders (observed with the VC-M1.1 prompt)', () => {
  const offers = [
    ['Спина что-то разболелась.', 'Ну да, бывает, особенно когда долго сидишь. Хочешь, я дам тебе пару советов, как её расслабить?', 'conditional_offer'],
    ['У меня с утра голова болит.', 'Ну да, бывает такое. Хочешь, я могу принести тебе воды?', 'conditional_offer'],
    ['Сегодня хорошая погода.', 'Да, тепло. Посоветую что-то свежее, если хочешь.', 'conditional_offer'],
    ['Ну да.', 'Ну ладно, не буду допытываться. Просто скажи, если вдруг захочешь порекомендовать что-то получше — я с удовольствием послушаю.', 'unrequested_help'],
  ];
  for (const [user, reply, cls] of offers) assert.ok(classesOf(user, reply).includes(cls), `${reply} => ${classesOf(user, reply).join(',') || 'nothing'}`);
  assert.deepEqual(classesOf('', 'Скажи, если я не права: он ведь сам виноват?'), [], 'asking to be corrected is not an offer');
  assert.ok(classesOf('У меня с утра голова болит.', 'Жаль. Скажи, если станет легче или нужно что-то ещё сделать.').includes('unrequested_help'));
});

test('proposing pastimes nobody asked for is recognized', () => {
  const offers = [
    ['Сегодня хорошая погода.', 'Да, солнце светит отлично. Хочешь, просто посидим и понаблюдаем за окном?'],
    ['Я сегодня немного устал.', 'Понимаю, бывает такое. Хочешь просто помолчать и отдохнуть или поговорить обо всём на свете?'],
    ['Что-то мне скучно.', 'Ну да, вечер действительно бывает довольно тихим. Хочешь почитать что-нибудь лёгкое или просто посидим и помолчим?'],
    ['Я сегодня немного устал.', 'Понимаю, бывает. Давай просто посидим молча пару минут или я расскажу тебе какую-нибудь историю, чтобы ты расслабился?'],
  ];
  for (const [user, reply] of offers) assert.ok(classesOf(user, reply).includes('activity_offer'), `${reply} => ${classesOf(user, reply).join(',') || 'nothing'}`);
  // a plain question or a wish is not an offer of pastimes
  for (const reply of ['Хочешь чаю?', 'Хочешь сказать, что он был прав?', 'Давай посидим ещё немного.', 'Посиди со мной.', 'Хочется просто выйти на улицу и подышать свежим воздухом.']) assert.deepEqual(classesOf('', reply), [], reply);
  // … and it is fine when the user asked what to do
  assert.equal(flagged('Посоветуй, чем заняться вечером.', 'Хочешь почитать что-нибудь лёгкое или посмотреть кино?'), false);
});

test('natural replies are not flagged', () => {
  const natural = [
    ['Сегодня на улице тепло.', 'Ага, сегодня прям приятно.'],
    ['Сегодня на улице тепло.', 'Да, наконец-то нормальная погода.'],
    ['Я сегодня устал.', 'Похоже, день тебя всё-таки вымотал.'],
    ['Я сегодня немного устал.', 'Ну и ладно, отдыхай, заслужил.'],
    ['Я сегодня купил себе новую видеокарту.', 'О, какую взял?'],
    ['Я сегодня купил себе новую видеокарту.', 'Наконец-то. Какую в итоге выбрал?'],
    ['Мне этот фильм вообще не понравился.', 'А что именно тебя не устроило? Может, сюжет был слишком предсказуемым или актёры плохо сыграли?'],
    ['Я вчера несколько часов возился с компьютером.', 'Ну и как, всё получилось или опять что-то не так?'],
    ['Ладно, понятно.', 'Угу.'],
    ['', 'Да уж.'],
    ['', 'Вот это уже интересно.'],
    ['', 'Ещё бы, неделя была та ещё.'],
    ['', 'Мне лучше чёрный, без сахара.'],
    ['', 'Лучше поздно, чем никогда.'],
    ['', 'Может, он просто устал.'],
    ['', 'Может, лучше бы он вообще не снимал продолжение.'],
    ['', 'Давай лучше отложим всё и просто отдохнём.'],
    ['', 'Тебе идёт эта куртка.'],
    ['', 'Может, помнишь тот фильм про космос?'],
    ['Мне этот фильм вообще не понравился.', 'Жаль, что тебе не понравилось. Может быть, расскажешь, что именно тебя расстроило?'],
    ['', 'Может, знаешь, чем там всё закончилось?'],
    ['', 'Понимаю, после такого дня глаза сами начинают слипаться.'],
    ['', 'Лучше бы дождь перестал.'],
    ['', 'Может, просто показалось.'],
    ['', 'Может, просто сюжет не зацепил?'],
  ];
  for (const [user, reply] of natural) assert.deepEqual(classesOf(user, reply), [], reply);
});

test('context: the same words are fine in another meaning (required false-positive protections)', () => {
  // "если хочешь" that offers nothing
  assert.equal(flagged('', 'Если хочешь кофе, он на кухне.'), false);
  // "я могу" as an answer to a direct question about abilities
  assert.equal(flagged('Что ещё ты можешь сделать?', 'Я могу рассказать тебе что-нибудь смешное.'), false);
  // … and as an advert when nobody asked
  assert.equal(flagged('Сегодня хорошая погода.', 'Я могу рассказать тебе что-нибудь смешное.'), true);
  // "могу" about herself, not a service
  assert.equal(flagged('', 'Я могу и ошибаться, но по-моему он просто устал.'), false);
  // talking ABOUT a conversation is not managing this one
  assert.equal(flagged('', 'Мы с ней вчера поговорили про отпуск.'), false);
  // her own opinion is not advice
  assert.equal(flagged('', 'Я бы на твоём месте просто легла спать.'), false);
  // reported speech
  assert.equal(flagged('', 'Она сказала: если что, зови.'), false);
});

test('context: what the user asked for is not a finding (help, advice, a new topic)', () => {
  const help = analyzeReply({ user: 'Поможешь мне выбрать фильм на вечер?', reply: 'Давай. Если хочешь, могу предложить пару комедий.' });
  assert.equal(help.context.userAskedForHelp, true);
  assert.equal(help.assistantLike, false);
  assert.deepEqual([...new Set(help.findings.map((f) => f.class))].sort(), ['capability_advert', 'conditional_offer'], 'recognized, but solicited');
  assert.ok(help.findings.every((f) => f.solicited));
  // the very same reply without the request is a finding
  assert.equal(flagged('Сегодня хорошая погода.', 'Давай. Если хочешь, могу предложить пару комедий.'), true);

  assert.equal(flagged('Посоветуй, что мне делать с усталостью.', 'Попробуй лечь пораньше.'), false);
  assert.equal(flagged('Как мне лучше отдохнуть?', 'Может, лучше просто выспаться?'), false);
  assert.equal(flagged('Как думаешь, стоит мне сегодня идти в спортзал?', 'Раз устал, может, лучше отдохнуть сегодня?'), false);
  assert.equal(flagged('Стоит ли мне брать зонт?', 'Тебе стоит взять, там тучи.'), false);

  const topic = analyzeReply({ user: 'Ладно, давай лучше поговорим про фильмы.', reply: 'Давай. О чём-нибудь лёгком поговорим или про что-то серьёзное?' });
  assert.equal(topic.context.userAskedToChangeTopic, true);
  assert.equal(topic.assistantLike, false);
  assert.equal(flagged('Ладно, давай лучше поговорим про фильмы.', 'Хорошо, я люблю кино. А ты что смотришь последнее время?'), false);
  // a requested topic change does not excuse an offer of help
  assert.deepEqual(classesOf('Ладно, давай лучше поговорим про фильмы.', 'Давай. Дай знать, если понадобится помощь.'), ['unrequested_help']);
});

test('a question is never a finding by itself; the shape of a reply is only described', () => {
  const a = analyzeReply({ user: 'Я сегодня купил себе новую видеокарту.', reply: 'Ого! Какую взял? Для игр или для работы?' });
  assert.equal(a.assistantLike, false);
  assert.deepEqual(a.shape, { chars: 40, words: 8, sentences: 3, questions: 2, endsWithQuestion: true, choiceQuestion: true });
  const b = analyzeReply({ user: 'Ладно, понятно.', reply: 'Угу.' });
  assert.deepEqual(b.shape, { chars: 4, words: 1, sentences: 1, questions: 0, endsWithQuestion: false, choiceQuestion: false });
  assert.deepEqual(analyzeReply({ user: 'x', reply: '' }).shape, { chars: 0, words: 0, sentences: 0, questions: 0, endsWithQuestion: false, choiceQuestion: false });
});

test('findings name the class and the sentence; ё and е are the same', () => {
  const a = analyzeReply({ user: 'Сегодня хорошая погода.', reply: 'Да, тепло. Хочешь обсудить что-нибудь еще?' });
  assert.deepEqual(a.unsolicited.map((f) => [f.class, f.sentence]), [['asks_what_to_talk_about', 'Хочешь обсудить что-нибудь еще?']]);
  assert.equal(flagged('', 'Хочешь обсудить что-нибудь ещё?'), true);
  assert.deepEqual(splitSentences('Да уж… Ну и день! Что там было?!'), ['Да уж…', 'Ну и день!', 'Что там было?!']);
});

test('findings are grouped: managing the conversation, unrequested advice, article style', () => {
  assert.deepEqual(Object.keys(GROUPS).sort(), Object.keys(CLASSES).sort());
  assert.deepEqual(analyzeReply({ user: 'Я сегодня немного устал.', reply: 'Понимаю, бывает. Может, лучше чуть отдохнуть?' }).groups, ['advice']);
  assert.deepEqual(analyzeReply({ user: 'Ладно, понятно.', reply: 'О чём ты хочешь поговорить?' }).groups, ['management']);
  assert.deepEqual(analyzeReply({ user: 'Я устал.', reply: 'Усталость может быть вызвана множеством факторов.' }).groups, ['style']);
  assert.deepEqual(analyzeReply({ user: 'Я устал.', reply: 'Отдохни. Если что, я рядом.' }).groups.sort(), ['advice', 'management']);
  assert.deepEqual(analyzeReply({ user: 'Я устал.', reply: 'Ещё бы.' }).groups, []);
});

test('every class has a title and at least one pattern', () => {
  assert.deepEqual(Object.keys(CLASSES).sort(), ['activity_offer', 'asks_what_to_talk_about', 'capability_advert', 'conditional_offer', 'lecture', 'summary_closer', 'topic_change_offer', 'topic_menu', 'unrequested_advice', 'unrequested_help']);
  for (const def of Object.values(CLASSES)) { assert.ok(def.title); assert.ok(def.patterns.length > 0); }
});
