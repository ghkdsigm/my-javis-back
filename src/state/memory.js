// src/state/memory.js

// 세션별 대화 메모리 (인메모리)
// 실제 운영에서는 Redis/DB로 교체하는 것을 권장합니다.
const sessions = new Map(); // sessionId -> { messages: Array<{role, content}>, updatedAt }

export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { messages: [], updatedAt: Date.now() });
  }
  return sessions.get(sessionId);
}

export function appendUser(sessionId, text) {
  const s = getSession(sessionId);
  s.messages.push({ role: 'user', content: text });
  s.updatedAt = Date.now();
}

export function appendAssistant(sessionId, text) {
  const s = getSession(sessionId);
  s.messages.push({ role: 'assistant', content: text });
  s.updatedAt = Date.now();
}

export function getContext(sessionId, maxTurns = 20) {
  const s = getSession(sessionId);
  const msgs = s.messages.slice(-maxTurns);
  const system = {
    role: 'system',
    content:
      '당신은 공손한 한국어 비서입니다. 불필요한 군더더기 없이, 존댓말로 간결히 답변합니다.',
  };
  return [system, ...msgs];
}

export function resetSession(sessionId) {
  sessions.set(sessionId, { messages: [], updatedAt: Date.now() });
}
