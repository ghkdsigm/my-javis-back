// 코드 주석에 이모티콘은 사용하지 않습니다.
import fetch from 'node-fetch';
import { createParser } from 'eventsource-parser';

const BASE = process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1'; // /v1 유지
const MODEL = process.env.LLM_MODEL || 'exaone3.5:7.8b';
const API_KEY = process.env.LLM_API_KEY || '';
const TZ = process.env.APP_TZ || 'Asia/Seoul';
const LOCALE = process.env.APP_LOCALE || 'ko-KR';

// 날짜·시간 구성 요소 + 요일 추출(KST)
function nowKSTParts() {
  const now = new Date();

  // 숫자 파트
  const dtParts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  }).formatToParts(now);

  const get = (t) => dtParts.find(p => p.type === t)?.value;
  const yyyy = get('year');
  const MM = get('month');
  const dd = get('day');
  const HH = get('hour');
  const mm = get('minute');

  // 한국어 요일
  const weekday = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    weekday: 'long'
  }).format(now); // 월요일~일요일

  return { yyyy, MM, dd, HH, mm, weekday };
}

// 12시간제 시각 문자열(요일 포함)
function formatKSTTimeLine() {
  const { MM, dd, HH, mm, weekday } = nowKSTParts();
  const month = String(Number(MM));
  const day = String(Number(dd));
  const hour24 = Number(HH);
  const hour12 = ((hour24 % 12) === 0) ? 12 : (hour24 % 12);
  const minute = String(Number(mm)).padStart(2, '0');
  return `${month}월 ${day}일 ${weekday} ${hour12}시 ${minute}분`;
}

// 간단 날짜 문자열(요일 포함)
function formatKSTDateLine() {
  const { MM, dd, weekday } = nowKSTParts();
  const month = String(Number(MM));
  const day = String(Number(dd));
  return `${month}월 ${day}일 ${weekday}`;
}

// 프리엠프: 사용자 질문에서 의도 감지
function detectTemporalIntent(text = '') {
  const s = String(text).toLowerCase().replace(/\s+/g, '');
  // 시간
  if (/(몇시|현재시간|지금시간|한국시간|kst|currenttime|timenow)/.test(s)) return 'time';
  // 전체 날짜(오늘 날짜/오늘 몇일 등)
  if (/(오늘날짜|오늘몇일|오늘이몇일)/.test(s)) return 'date';
  // 일(며칠/몇일)
  if (/(며칠|몇일)/.test(s)) return 'day';
  // 월
  if (/(몇월)/.test(s)) return 'month';
  // 요일
  if (/(무슨요일|요일이야|요일)/.test(s)) return 'weekday';
  // 년
  if (/(몇년)/.test(s)) return 'year';
  return null;
}

// 의도별 즉답 출력
function respondTemporalIntent(intent, res) {
  const { yyyy, MM, dd, weekday } = nowKSTParts();
  const month = String(Number(MM));
  const day = String(Number(dd));

  switch (intent) {
    case 'time': {
      const line = `마스터, 현재 시간 ${formatKSTTimeLine()} 입니다.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'date': {
      const line = `마스터, 오늘은 ${formatKSTDateLine()} 입니다.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'day': {
      const line = `마스터, 오늘은 ${day}일 입니다.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'month': {
      const line = `마스터, 지금은 ${month}월 입니다.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'weekday': {
      const line = `마스터, 오늘은 ${weekday} 입니다.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    case 'year': {
      const line = `마스터, 올해는 ${yyyy}년 입니다.\n`;
      res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
      return true;
    }
    default:
      return false;
  }
}

export async function llamaCppStream(userText, res) {
  // 시간/날짜/요일/월/일/년 질의는 LLM 호출 없이 즉답
  const intent = detectTemporalIntent(userText);
  if (intent) {
    const handled = respondTemporalIntent(intent, res);
    if (handled) return;
  }

  const url = `${BASE.replace(/\/$/, '')}/chat/completions`;

  // 시스템 규칙: 톤과 KST 기준만 안내(현재 시간·날짜는 프리엠프에서 처리)
  const system = [
    '역할: 한국어 어드바이저(영화 아이언맨 JARVIS 톤).',
    "항상 사용자를 '마스터'라고 부른다.",
    '과도한 격식은 지양하고 자연스러운 존댓말, 가벼운 농담은 허용하되 무례한 유머는 금지.',
    '답변은 간결하고 실행 중심. 단계가 필요하면 번호 목록 사용.',
    '이모티콘은 사용하지 않는다.',
    '모든 날짜·시간 해석은 한국시간(Asia/Seoul, KST) 기준으로 한다.'
  ].join(' ');

  const body = {
    model: MODEL,
    stream: true,
    temperature: 0.7,
    messages: [
      { role: 'system', content: system },
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
