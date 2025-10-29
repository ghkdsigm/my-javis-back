// 코드 주석에 이모티콘은 사용하지 않습니다.
import fetch from 'node-fetch';
import { createParser } from 'eventsource-parser';

const BASE   = process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1'; // /v1 유지
const MODEL  = process.env.LLM_MODEL    || 'exaone3.5:7.8b';
const API_KEY = process.env.LLM_API_KEY || '';
const TZ     = process.env.APP_TZ       || 'Asia/Seoul';
const LOCALE = process.env.APP_LOCALE   || 'ko-KR';

/**
 * KST 기준 날짜/시간 구성 요소 추출
 */
function nowKSTParts() {
  const now = new Date();

  const dtParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  }).formatToParts(now);

  const get = (t) => dtParts.find(p => p.type === t)?.value;
  const yyyy = get('year');
  const MM   = get('month');
  const dd   = get('day');
  const HH   = get('hour');
  const mm   = get('minute');

  const weekday = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    weekday: 'long'
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
  const hour12 = ((hour24 % 12) === 0) ? 12 : (hour24 % 12);
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
 * - 지나치게 포괄적인 키워드는 지양해야 하며, 여기서는 단순 매치만 수행
 * - 실제 프리엠프 호출은 아래 llamaCppStream()에서 추가 휴리스틱으로 제한
 */
function detectTemporalIntent(text = '') {
  const s = String(text).toLowerCase().replace(/\s+/g, '');
  if (/(몇시|현재시간|지금시간|한국시간|kst|currenttime|timenow)/.test(s)) return 'time';
  if (/(오늘날짜|오늘몇일|오늘이몇일)/.test(s)) return 'date';
  if (/(며칠|몇일)/.test(s)) return 'day';
  if (/(몇월)/.test(s)) return 'month';
  if (/(무슨요일|요일이야|요일)/.test(s)) return 'weekday';
  if (/(몇년)/.test(s)) return 'year';
  return null;
}

/**
 * 의도별 즉답 출력 (SSE data 프레임)
 */
function respondTemporalIntent(intent, res) {
  const { yyyy, MM, dd, weekday } = nowKSTParts();
  const month = String(Number(MM));
  const day   = String(Number(dd));

  switch (intent) {
    case 'time': {
      const line = `현재 시간 ${formatKSTTimeLine()} 이에요.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'date': {
      const line = `오늘은 ${formatKSTDateLine()} 이에요.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'day': {
      const line = `오늘은 ${day}일 이에요.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'month': {
      const line = `지금은 ${month}월 이에요.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'weekday': {
      const line = `오늘은 ${weekday} 이에요.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'year': {
      const line = `올해는 ${yyyy}년 이에요.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    default:
      return false;
  }
}

/**
 * OpenAI 호환 스트리밍 호출 어댑터
 * - 기본적으로 /v1/chat/completions 로 스트림
 * - 프리엠프(시간/날짜 즉답)는 단문일 때만 가동
 * - opts.noTemporalShortcut === true 일 때 프리엠프를 비활성화
 *
 * @param {string} userText - 사용자 프롬프트(혹은 요약용 합성 프롬프트)
 * @param {ServerResponse|Writable} res - SSE 목적지(writer 호환 객체)
 * @param {object} opts
 *   - noTemporalShortcut?: boolean  프리엠프(시간/날짜 즉답) 완전 비활성화
 *   - temperature?: number          모델 온도(기본 0.7)
 *   - systemPrompt?: string         시스템 메시지 교체용
 */
export async function llamaCppStream(userText, res, opts = {}) {
  const {
    noTemporalShortcut = false,
    temperature = 0.7,
    systemPrompt,
  } = opts;

  // 프리엠프는 "짧고 단문"일 때만 작동시켜 오작동을 방지한다.
  // 기준: 40자 이하, 개행 없음, 공백 3개 이하.
  const s = typeof userText === 'string' ? userText : '';
  const shortAndSimple =
    s.length > 0 &&
    s.length <= 40 &&
    !/\n/.test(s) &&
    (s.match(/\s+/g)?.length ?? 0) <= 3;

  if (!noTemporalShortcut && shortAndSimple) {
    const intent = detectTemporalIntent(s);
    if (intent) {
      const handled = respondTemporalIntent(intent, res);
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
    '모든 날짜·시간 해석은 한국시간(Asia/Seoul, KST) 기준으로 한다.'
  ].join(' ');

  const body = {
    model: MODEL,
    stream: true,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt || defaultSystem },
      { role: 'user', content: userText }
    ]
  };

  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => '');
    throw new Error(`OpenAI-compatible request failed: ${r.status} ${r.statusText} ${text}`);
  }

  const parser = createParser((event) => {
    if (event.type !== 'event') return;
    if (event.data === '[DONE]') return;
    try {
      const json = JSON.parse(event.data);
      const delta = json.choices?.[0]?.delta?.content || '';
      if (delta) res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
    } catch {}
  });

  for await (const chunk of r.body) {
    parser.feed(chunk.toString('utf8'));
  }
}
