'use strict';

/**
 * Build the chat-completions message list:
 *   [system prompt] + bounded session history + current user message.
 */
function buildMessages({ systemPrompt, historyMessages = [], userText }) {
  const messages = [];
  const sys = String(systemPrompt ?? '').trim();
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of historyMessages) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: String(userText).trim() });
  return messages;
}

module.exports = { buildMessages };
