// src/utils/summarize.js
// 코드 주석에 이모티콘은 사용하지 않습니다.
import fetch from 'node-fetch';

const BASE = process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.LLM_MODEL || 'exaone3.5:7.8b';
const API_KEY = process.env.LLM_API_KEY || '';

async function quickComplete(prompt) {
  const url = `${BASE.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: MODEL,
    stream: false,
    temperature: 0.2,
    messages: [
      { role: 'system', content: '너는 한국어 요약기다. 핵심만 3~5줄로 간결히 불릿으로 요약한다. 불필요한 말은 하지 않는다.' },
      { role: 'user', content: prompt }
    ]
  };
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`summarize http ${r.status}`);
  const json = await r.json();
  return json?.choices?.[0]?.message?.content || '';
}

/** 입력이 길면 요약해 반환, 아니면 원문 그대로 반환 */
export async function summarizeInputIfLong(text, charLimit = 1200) {
  const t = String(text || '');
  if (t.length <= charLimit) return t;
  const prompt = `다음 한국어 텍스트의 핵심만 3~5줄 불릿으로 요약해줘:\n\n${t}`;
  try {
    const s = await quickComplete(prompt);
    return s && s.trim() ? `요약:\n${s.trim()}` : t.slice(0, charLimit) + ' ...';
  } catch {
    // 요약 실패 시 안전하게 절단
    return t.slice(0, charLimit) + ' ...';
  }
}
