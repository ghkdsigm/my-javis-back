// src/state/memory.js
// 코드 주석에 이모티콘은 사용하지 않습니다.


const sessions = new Map(); // sessionId -> { messages: Array<{role, content}>, updatedAt, newsCache?: Array }


export function getSession(sessionId) {
if (!sessions.has(sessionId)) {
sessions.set(sessionId, { messages: [], updatedAt: Date.now(), newsCache: [] });
}
return sessions.get(sessionId);
}


export function appendUser(sessionId, text) {
const s = getSession(sessionId);
s.messages.push({ role: 'user', content: String(text || '') });
s.updatedAt = Date.now();
}


export function appendAssistant(sessionId, text) {
const s = getSession(sessionId);
s.messages.push({ role: 'assistant', content: String(text || '') });
s.updatedAt = Date.now();
}


// 최근 turnPairs(유저-어시스턴트) 기준으로 10턴(=20메시지)만 유지
export function getContext(sessionId, turnPairs = 10) {
const s = getSession(sessionId);
const msgs = s.messages.slice(-(turnPairs * 2));
const system = {
role: 'system',
content: '당신은 공손한 한국어 비서입니다. 불필요한 군더더기 없이, 존댓말로 간결히 답변합니다.',
};
return [system, ...msgs];
}


export function resetSession(sessionId) {
sessions.set(sessionId, { messages: [], updatedAt: Date.now(), newsCache: [] });
}


// 추가: 뉴스 캐시 보관/조회
export function setNewsCache(sessionId, items) {
const s = getSession(sessionId);
s.newsCache = Array.isArray(items) ? items.slice(0) : [];
}


export function getNewsCache(sessionId) {
const s = getSession(sessionId);
return Array.isArray(s.newsCache) ? s.newsCache : [];
}