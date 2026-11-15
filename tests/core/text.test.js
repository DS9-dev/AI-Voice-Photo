'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamingSentenceSplitter, splitSentences } = require('../../core/conversation/sentenceSplitter');
const { ThinkFilter } = require('../../core/conversation/thinkFilter');
const { SseParser } = require('../../core/util/sse');

function streamSplit(chunks, opts) {
  const sp = new StreamingSentenceSplitter(opts);
  const out = [];
  for (const c of chunks) out.push(...sp.push(c));
  out.push(...sp.flush());
  return out;
}

test('splits sentences as they complete, token by token', () => {
  const text = 'Привет, рад тебя слышать! Как прошёл твой день? Расскажи подробнее.';
  const tokens = text.match(/.{1,3}/gs);
  assert.deepEqual(streamSplit(tokens), ['Привет, рад тебя слышать!', 'Как прошёл твой день?', 'Расскажи подробнее.']);
});

test('a sentence is emitted before the rest of the answer arrives', () => {
  const sp = new StreamingSentenceSplitter();
  assert.deepEqual(sp.push('Это первое предложение.'), []);       // boundary not confirmed yet
  assert.deepEqual(sp.push(' А это'), ['Это первое предложение.']);
  assert.deepEqual(sp.flush(), ['А это']);
});

test('short fragments are merged with the following sentence', () => {
  assert.deepEqual(splitSentences('Да. Конечно, я помогу тебе.'), ['Да. Конечно, я помогу тебе.']);
  assert.deepEqual(splitSentences('Да.'), ['Да.']);
});

test('does not split inside numbers or without following whitespace', () => {
  assert.deepEqual(splitSentences('Это стоит 3.5 рубля за штуку. Недорого же!'), ['Это стоит 3.5 рубля за штуку.', 'Недорого же!']);
});

test('handles ellipsis, ?!, closing quotes and newlines', () => {
  assert.deepEqual(splitSentences('Ну не знаю... Может быть, завтра?! Она сказала «привет всем».\nИ ушла домой'),
    ['Ну не знаю...', 'Может быть, завтра?!', 'Она сказала «привет всем».', 'И ушла домой']);
});

test('empty and whitespace-only input yields nothing', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('  \n '), []);
});

test('think filter removes inline reasoning even when tags are split across chunks', () => {
  const f = new ThinkFilter();
  let content = '';
  let reasoning = '';
  for (const chunk of ['<th', 'ink>пользователь ', 'спрашивает</th', 'ink>\n\nПривет', '! Как дела?']) {
    const r = f.push(chunk);
    content += r.content;
    reasoning += r.reasoning;
  }
  const tail = f.flush();
  content += tail.content;
  reasoning += tail.reasoning;
  assert.equal(content.trim(), 'Привет! Как дела?');
  assert.equal(reasoning, 'пользователь спрашивает');
});

test('think filter passes normal text through, including a lone "<"', () => {
  const f = new ThinkFilter();
  let content = '';
  for (const chunk of ['2 < 3, это ', 'правда', '.']) content += f.push(chunk).content;
  content += f.flush().content;
  assert.equal(content, '2 < 3, это правда.');
});

test('think filter: unterminated reasoning is never emitted as content', () => {
  const f = new ThinkFilter();
  const a = f.push('<think>долго думаю');
  const b = f.flush();
  assert.equal(a.content + b.content, '');
  assert.equal(a.reasoning + b.reasoning, 'долго думаю');
});

test('think filter flags a closing tag without an opening tag', () => {
  const f = new ThinkFilter();
  const r = f.push('скрытые мысли</think>Ответ');
  assert.equal(r.reasoning, 'скрытые мысли');
  assert.equal(r.content + f.flush().content, 'Ответ');
  assert.equal(f.sawOrphanClose, true);
});

test('SSE parser handles events split across chunks, CRLF and comments', () => {
  const p = new SseParser();
  const out = [];
  out.push(...p.feed('data: {"a"'));
  out.push(...p.feed(':1}\n\n: keep-alive\n\ndata: {"b":2}\r\n\r\nda'));
  out.push(...p.feed('ta: [DONE]\n\n'));
  assert.deepEqual(out, ['{"a":1}', '{"b":2}', '[DONE]']);
});

test('SSE parser flushes a final event without trailing blank line', () => {
  const p = new SseParser();
  assert.deepEqual(p.feed('data: last'), []);
  assert.deepEqual(p.end(), ['last']);
});
