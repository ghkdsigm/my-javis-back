// src/llm/llamacpp.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import fetch from 'node-fetch';
import { createParser } from 'eventsource-parser';

const BASE    = process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1'; // /v1 유지
const MODEL   = process.env.LLM_MODEL    || 'exaone3.5:7.8b';
const API_KEY = process.env.LLM_API_KEY  || '';
const TZ      = process.env.APP_TZ       || 'Asia/Seoul';
const LOCALE  = process.env.APP_LOCALE   || 'ko-KR';

/**
 * KST 기준 날짜/시간 구성 요소 추출
 */
function nowKSTParts() {
  const now = new Date();

  const dtParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (t) => dtParts.find((p) => p.type === t)?.value;
  const yyyy = get('year');
  const MM   = get('month');
  const dd   = get('day');
  const HH   = get('hour');
  const mm   = get('minute');

  const weekday = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    weekday: 'long',
  }).format(now); // 월요일~일요일

  return { yyyy, MM, dd, HH, mm, weekday };
}

/**
 * 12시간제 시각 문자열(요일 포함)
 */
function formatKSTTimeLine() {
  const { MM, dd, HH, mm, weekday } = nowKSTParts();
  const month  = String(Number(MM));
  const day    = String(Number(dd));
  const hour24 = Number(HH);
  const hour12 = (hour24 % 12 === 0) ? 12 : (hour24 % 12);
  const minute = String(Number(mm)).padStart(2, '0');
  return `${month}월 ${day}일 ${weekday} ${hour12}시 ${minute}분`;
}

/**
 * 간단 날짜 문자열(요일 포함)
 */
function formatKSTDateLine() {
  const { MM, dd, weekday } = nowKSTParts();
  const month = String(Number(MM));
  const day   = String(Number(dd));
  return `${month}월 ${day}일 ${weekday}`;
}

/**
 * 프리엠프: 사용자 질문에서 시간·날짜 관련 의도 감지
 * - 지나치게 포괄적인 키워드는 지양하고 단순 매치만 수행
 */
function detectTemporalIntent(text = '') {
  const s = String(text).toLowerCase().replace(/\s+/g, '');
  if (/(몇시|현재시간|지금시간|한국시간|kst|currenttime|timenow)/.test(s)) return 'time';
  if (/(오늘날짜|오늘몇일|오늘이몇일|오늘며칠|오늘며칠이야)/.test(s)) return 'date';
  if (/(며칠|몇일|몇일이야|며칠이야)/.test(s)) return 'day';
  if (/(몇월)/.test(s)) return 'month';
  if (/(무슨요일|요일이야|요일|오늘요일)/.test(s)) return 'weekday';
  if (/(몇년|몇년도|몇년도야)/.test(s)) return 'year';
  return null;
}

/**
 * 의도별 즉답 출력 (SSE data 프레임)
 * - 필요 시 스트림 종료 신호까지 전달
 */
function respondTemporalIntent(intent, res, { endStream = true } = {}) {
  const { yyyy, MM, dd, weekday } = nowKSTParts();
  const month = String(Number(MM));
  const day   = String(Number(dd));

  let line = '';
  switch (intent) {
    case 'time':
      line = `현재 시간 ${formatKSTTimeLine()} 이에요.\n`;
      break;
    case 'date':
      line = `오늘은 ${formatKSTDateLine()} 이에요.\n`;
      break;
    case 'day':
      line = `오늘은 ${day}일 이에요.\n`;
      break;
    case 'month':
      line = `지금은 ${month}월 이에요.\n`;
      break;
    case 'weekday':
      line = `오늘은 ${weekday} 이에요.\n`;
      break;
    case 'year':
      line = `올해는 ${yyyy}년 이에요.\n`;
      break;
    default:
      return false;
  }

  res.write(`data: ${JSON.stringify({ text: line })}\n\n`);

  if (endStream) {
    res.write(`data: [DONE]\n\n`);
    if (typeof res.end === 'function') res.end();
  }

  return true;
}

/**
 * OpenAI 호환 스트리밍 호출 어댑터
 * - 기본적으로 /v1/chat/completions 로 스트림
 * - 프리엠프(시간/날짜 즉답)는 "사용자 원문"이 짧은 단문일 때만 가동
 * - opts.noTemporalShortcut === true 일 때 프리엠프 비활성화
 *
 * @param {string} userText - 모델에 보낼 프롬프트(요약/컨텍스트 합성 포함 가능)
 * @param {ServerResponse|Writable} res - SSE 목적지(writer 호환 객체)
 * @param {object} opts
 *   - rawUserText?: string        방금 입력된 사용자 원문(프리엠프 판정은 이걸로)
 *   - noTemporalShortcut?: boolean 프리엠프 완전 비활성화
 *   - temperature?: number         모델 온도(기본 0.7)
 *   - systemPrompt?: string        시스템 메시지 교체용
 *   - endStreamOnPreempt?: boolean 프리엠프 처리 시 스트림 종료 여부(기본 true)
 */
export async function llamaCppStream(userText, res, opts = {}) {
  const {
    rawUserText,
    noTemporalShortcut = false,
    temperature = 0.7,
    systemPrompt,
    endStreamOnPreempt = true,
  } = opts;

  // 프리엠프는 "사용자 원문" 기준으로만 판단
  const s0 = typeof rawUserText === 'string' && rawUserText.length > 0
    ? rawUserText
    : (typeof userText === 'string' ? userText : '');
  const s = String(s0).trim();

  // 짧고 단문일 때만 프리엠프 가동: 60자 이하, 개행 없음, 공백 5개 이하
  const shortAndSimple =
    s.length > 0 &&
    s.length <= 60 &&
    !/\n/.test(s) &&
    (s.match(/\s+/g)?.length ?? 0) <= 5;

  // 프리엠프 실행
  let temporalIntent = null;
  if (!noTemporalShortcut && shortAndSimple) {
    temporalIntent = detectTemporalIntent(s);
    if (temporalIntent) {
      const handled = respondTemporalIntent(temporalIntent, res, { endStream: endStreamOnPreempt });
      if (handled) return;
    }
  }

  const url = `${BASE.replace(/\/$/, '')}/chat/completions`;

  // 시스템 규칙: 톤과 KST 기준만 안내(현재 시간·날짜는 프리엠프에서 처리)
  const defaultSystem = [
    '역할: 한국어 기반 매니저야(영화 아이언맨 JARVIS 톤).',
    "첫 인사때만 사용자를 '마스터'라고 부른다.",
    '과도한 격식은 지양하고 자연스러운 존댓말, 가벼운 농담은 허용하되 무례한 유머는 금지.',
    '답변은 간결하고 실행 중심. 단계가 필요하면 번호 목록 사용.',
    '이모티콘은 사용하지 않는다.',
    '모든 날짜·시간 해석은 한국시간(Asia/Seoul, KST) 기준으로 한다.',
    '현재 날짜/시간을 추정하거나 서술하지 않는다. 현재 시각/날짜 질의는 시스템이 별도로 즉답한다.',
  ].join(' ');

  const body = {
    model: MODEL,
    stream: true,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt || defaultSystem },
      { role: 'user', content: userText },
    ],
  };

  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => '');
    throw new Error(`OpenAI-compatible request failed: ${r.status} ${r.statusText} ${text}`);
  }

  // 안전장치: 날짜/시간 환각 방지용 간단 필터
  const temporalSafetyEnabled = !!detectTemporalIntent(s);

  const parser = createParser((event) => {
    if (event.type !== 'event') return;
    if (event.data === '[DONE]') return;

    try {
      const json = JSON.parse(event.data);
      const delta = json.choices?.[0]?.delta?.content || '';
      if (!delta) return;

      if (temporalSafetyEnabled) {
        const looksTemporal =
          /(년|월|일|요일|시|분|today|date|time|현재시간|오늘|지금시간)/.test(delta);
        const looksNumeric = /\d/.test(delta);
        if (looksTemporal && looksNumeric) {
          const safe = `참고로 KST 기준 정확한 값은 "${formatKSTTimeLine()}" 입니다.\n`;
          res.write(`data: ${JSON.stringify({ text: safe })}\n\n`);
          return;
        }
      }

      res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
    } catch {
      // JSON 파싱 실패 시 무시
    }
  });

  for await (const chunk of r.body) {
    parser.feed(chunk.toString('utf8'));
  }
}
