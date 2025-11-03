// src/llm/openaiCompat.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import fetch from 'node-fetch';
import { createParser } from 'eventsource-parser';

const BASE   = process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL  = process.env.LLM_MODEL || 'qwen2.5vl:7b';

const TZ     = process.env.APP_TZ || 'Asia/Seoul';
const LOCALE = process.env.APP_LOCALE || 'ko-KR';

// ---- 시간 유틸 (KST 보호 출력에 사용) --------------------------------------

function nowKSTParts() {
  const now = new Date();
  const dtParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(now);
  const get = (t) => dtParts.find(p => p.type === t)?.value;
  const yyyy = get('year'); const MM = get('month'); const dd = get('day');
  const HH = get('hour');  const mm = get('minute');
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

function detectTemporalIntent(text = '') {
  const s = String(text).toLowerCase().replace(/\s+/g, '');
  if (/(몇시|현재시간|지금시간|한국시간|kst|currenttime|timenow)/.test(s)) return true;
  if (/(오늘날짜|오늘몇일|오늘이몇일|오늘며칠|오늘며칠이야)/.test(s)) return true;
  if (/(며칠|몇일|몇일이야|며칠이야)/.test(s)) return true;
  if (/(몇월)/.test(s)) return true;
  if (/(무슨요일|요일이야|요일|오늘요일)/.test(s)) return true;
  if (/(몇년|몇년도|몇년도야)/.test(s)) return true;
  return false;
}

// ---- 스트리밍 채팅: OpenAI 호환 /v1/chat/completions(stream) ---------------

/**
 * 사용자 텍스트를 OpenAI 호환 챗 컴플리션 스트림으로 호출하고
 * SSE/WS 브로드캐스트 writer(res)에 {text: "<delta>"} 형태로 흘려보낸다.
 *
 * @param {string} userText - LLM에 전달할 사용자 입력(컨텍스트 합성 결과)
 * @param {object} res - write(dataLine) 가능한 writer (makeSessionSSEWriter 등)
 * @param {object} opts - { rawUserText?: string }
 */
export async function openaiStreamChat(userText, res, { rawUserText } = {}) {
  const url = `${BASE.replace(/\/$/, '')}/chat/completions`;

  const system = [
    '역할: 한국어 비서.',
    '이모티콘은 사용하지 않는다.',
    '모든 날짜/시간 해석은 한국시간(Asia/Seoul, KST) 기준으로 한다.',
    '현재 날짜/시간을 추정하거나 임의로 생성하지 않는다.'
  ].join(' ');

  const body = {
    model: MODEL,
    stream: true,
    temperature: 0.2,
    max_tokens: 1200,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: String(userText ?? '') }
    ]
  };

  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`openaiCompat http ${r.status} ${t}`);
  }

  const guardTemporal = detectTemporalIntent(rawUserText || userText);

  const parser = createParser((event) => {
    if (event.type !== 'event') return;
    if (event.data === '[DONE]') return;
    try {
      const json  = JSON.parse(event.data);
      const delta = json?.choices?.[0]?.delta?.content || '';
      if (!delta) return;

      if (guardTemporal) {
        const looksTemporal = /(년|월|일|요일|시|분|today|date|time|현재시간|오늘|지금시간)/.test(delta);
        const looksNumeric  = /\d/.test(delta);
        if (looksTemporal && looksNumeric) {
          const safe = `참고로 KST 기준 정확한 값은 "${formatKSTTimeLine()}" 입니다.\n`;
          res.write(`data: ${JSON.stringify({ text: safe })}\n\n`);
          return;
        }
      }

      res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
    } catch {
      // 파싱 오류 무시
    }
  });

  for await (const chunk of r.body) {
    parser.feed(chunk.toString('utf8'));
  }
}

// ---- 비전 단발 호출: 이미지+텍스트, non-stream -----------------------------

/**
 * 이미지(Base64) 배열과 텍스트를 받아 단발(non-stream) 호출.
 * OpenAI 호환 /v1/chat/completions 엔드포인트 기준.
 *
 * @param {object} args
 * @param {string} [args.model] - 미지정 시 상단 MODEL 사용
 * @param {string} [args.text]
 * @param {string[]} [args.imagesBase64]
 * @param {string[]} [args.mimeTypes] - 각 이미지의 MIME 타입 (image/jpeg 등)
 * @returns {Promise<string>} - 모델 응답 텍스트
 */
export async function openaiVisionOnce({ model, text, imagesBase64 = [], mimeTypes = [] }) {
  const url = `${BASE.replace(/\/$/, '')}/chat/completions`;
  const useModel = String(model || MODEL);

  const content = [];
  if (text) {
    content.push({ type: 'text', text: String(text) });
  }
  for (let i = 0; i < imagesBase64.length; i++) {
    const b64 = imagesBase64[i];
    if (!b64) continue;
    const mt = String(mimeTypes[i] || 'image/jpeg');
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mt};base64,${b64}` }
    });
  }

  const body = {
    model: useModel,
    temperature: 0.2,
    max_tokens: 1200,
    messages: [{ role: 'user', content }]
  };

  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`openaiVisionOnce failed: ${res.status} ${t}`);
  }
  const json = await res.json();
  const txt =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.message?.parts?.map(p => p?.text || '').join('') ??
    '';
  return String(txt || '');
}
