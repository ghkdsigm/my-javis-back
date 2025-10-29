// src/llm/openaiCompat.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import fetch from 'node-fetch';
import { createParser } from 'eventsource-parser';

const BASE = process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'exaone3.5:7.8b';

const TZ = process.env.APP_TZ || 'Asia/Seoul';
const LOCALE = process.env.APP_LOCALE || 'ko-KR';

function nowKSTParts() {
  const now = new Date();
  const dtParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(now);
  const get = (t) => dtParts.find(p => p.type === t)?.value;
  const yyyy = get('year'); const MM = get('month'); const dd = get('day');
  const HH = get('hour'); const mm = get('minute');
  const weekday = new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, weekday: 'long' }).format(now);
  return { yyyy, MM, dd, HH, mm, weekday };
}
function formatKSTTimeLine() {
  const { MM, dd, HH, mm, weekday } = nowKSTParts();
  const month  = String(Number(MM));
  const day    = String(Number(dd));
  const hour24 = Number(HH);
  const hour12 = (hour24 % 12 === 0) ? 12 : (hour24 % 12);
  const minute = String(Number(mm)).padStart(2, '0');
  return `${month}월 ${day}일 ${weekday} ${hour12}시 ${minute}분`;
}
function detectTemporalIntent(text='') {
  const s = String(text).toLowerCase().replace(/\s+/g, '');
  if (/(몇시|현재시간|지금시간|한국시간|kst|currenttime|timenow)/.test(s)) return true;
  if (/(오늘날짜|오늘몇일|오늘이몇일|오늘며칠|오늘며칠이야)/.test(s)) return true;
  if (/(며칠|몇일|몇일이야|며칠이야)/.test(s)) return true;
  if (/(몇월)/.test(s)) return true;
  if (/(무슨요일|요일이야|요일|오늘요일)/.test(s)) return true;
  if (/(몇년|몇년도|몇년도야)/.test(s)) return true;
  return false;
}

export async function openaiStreamChat(userText, res, { rawUserText } = {}) {
  const url = `${BASE.replace(/\/$/, '')}/chat/completions`;
  const defaultSystem = [
    '역할: 한국어 기반 매니저다.',
    '이모티콘은 사용하지 않는다.',
    '모든 날짜·시간 해석은 한국시간(Asia/Seoul, KST) 기준으로 한다.',
    '현재 날짜/시간을 추정하거나 서술하지 않는다. 시간/날짜 질의는 시스템이 별도로 즉답한다.'
  ].join(' ');

  const body = {
    model: MODEL,
    stream: true,
    temperature: 0.7,
    messages: [
      { role: 'system', content: defaultSystem },
      { role: 'user', content: userText }
    ]
  };
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`openaiCompat http ${r.status}`);

  const safety = detectTemporalIntent(rawUserText || userText);

  const parser = createParser((event) => {
    if (event.type !== 'event') return;
    if (event.data === '[DONE]') return;
    try {
      const json = JSON.parse(event.data);
      const delta = json.choices?.[0]?.delta?.content || '';
      if (!delta) return;
      if (safety) {
        const looksTemporal = /(년|월|일|요일|시|분|today|date|time|현재시간|오늘|지금시간)/.test(delta);
        const looksNumeric = /\d/.test(delta);
        if (looksTemporal && looksNumeric) {
          const safe = `참고로 KST 기준 정확한 값은 "${formatKSTTimeLine()}" 입니다.\n`;
          res.write(`data: ${JSON.stringify({ text: safe })}\n\n`);
          return;
        }
      }
      res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
    } catch {}
  });

  for await (const chunk of r.body) {
    parser.feed(chunk.toString('utf8'));
  }
}
