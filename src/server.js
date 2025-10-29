// JARVIS BACKEND/src/server.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import 'dotenv/config';
import express from 'express';
import jarvisRoute from "./routes/jarvis.route.js";
import cors from 'cors';
import http from 'http';
import { attachWS, wsSend } from './ws.js';
import { openaiStreamChat } from './llm/openaiCompat.js';
import { llamaCppStream } from './llm/llamacpp.js';
import { maybeEmitToolEvent } from './tools/router.js';
import {
  appendUser,
  appendAssistant,
  getContext,
} from './state/memory.js';
import { flattenMessages } from './utils/flatten.js';
import { summarizeInputIfLong } from './utils/summarize.js';
import locationRoute from "./routes/location.route.js";
import meetingRoute from "./routes/meeting.route.js"; // ESM import

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const LLM_MODE = (process.env.LLM_MODE || 'openai').toLowerCase();

// --- 세션/웨이크워드/토픽(회의) 관리 -----------------------------

const FIVE_MIN = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

// --- 웨이크워드 유틸(관대 매칭) ---------------------------------

// 보이지 않는 공백/제어문자 제거 + 전각/인용부호/이모지 등 앞머리 장식 제거 + NFKC 정규화
function normalizeForWake(text = "") {
  let s = String(text ?? "");

  // 유니코드 정규화 (전각/호환문자 → 표준)
  try { s = s.normalize('NFKC'); } catch {}

  // 제로폭 문자/제어문자 제거
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');

  // 앞머리 장식 기호/따옴표/괄호/이모지 일부 제거
  s = s.replace(/^[\s“”"‘’'`·・•~\-—–_=+*\[\]{}()<>〈〉〔〕【】「」『』❝❞⭐️✨💬🙂🙃👍👌🙏….,!?]+/u, '');

  // 트림
  s = s.trim();

  return s;
}

// 웨이크워드 매칭: 다양한 한/영 변형 + 붙여 말하기 허용
// 반환 { ok: boolean, rest: string }
function matchWake(text = "") {
  const raw = String(text ?? "");
  const s = normalizeForWake(raw);
  const lower = s.toLowerCase();

  // 유니코드 경계: 공백, 문장부호, 문자열 끝이면 경계로 인정
  const END = String.raw`(?:\s|$|[\p{P}\p{S}])`; // requires /u

  // 허용 패턴들
  const patterns = [
    // 한글
    new RegExp(`^(?:헤이|해이)\\s*자비스${END}`, 'u'),     // "헤이 자비스", "해이     자비스"
    new RegExp(`^(?:헤이자비스|해이자비스)${END}`, 'u'),   // "헤이자비스" (붙여 말하기)

    // 영어(정상 + 흔한 오타, 붙여 말하기/띄어쓰기 모두 허용)
    new RegExp(`^hey\\s*jarvis(e)?${END}`, 'iu'),          // hey jarvis / jarvise / heyjarvis
    new RegExp(`^hey\\s*javis${END}`, 'iu'),               // hey javis
    new RegExp(`^hey\\s*jarvice${END}`, 'iu'),             // hey jarvice
    new RegExp(`^hey\\s*javice${END}`, 'iu'),              // hey javice (r 빠진 오타)
  ];

  for (const re of patterns) {
    const m = lower.match(re);
    if (m) {
      // 매치한 부분을 떼고, 뒤쪽의 구두점/공백 제거
      const rest = s.slice(m[0].length).replace(/^[\s,.:;!~\-—–_…“”"‘’']+/u, '').trim();
      return { ok: true, rest };
    }
  }

  return { ok: false, rest: s };
}

// 디버그 로그 헬퍼
function logWakeDebug(sessionId, text) {
  const n = normalizeForWake(text);
  const r = matchWake(text);
  console.log('[wake-check]', { sessionId, raw: text, normalized: n, matched: r.ok, rest: r.rest });
}

// 세션 저장소: sessionId -> { armed, lastAt, topics:{ meeting:{active,logs[],startedAt,endedAt} } }
const sessions = new Map();

function now() { return Date.now(); }

function ensureSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      armed: false,
      lastAt: now(),
      topics: {
        meeting: { active: false, logs: [], startedAt: null, endedAt: null },
      },
    });
  }
  return sessions.get(sessionId);
}
function arm(sessionId) {
  const s = ensureSession(sessionId);
  s.armed = true;
  s.lastAt = now();
}
function disarm(sessionId) {
  const s = ensureSession(sessionId);
  s.armed = false;
}
function touch(sessionId) {
  const s = ensureSession(sessionId);
  s.lastAt = now();
}
function expired(sessionId) {
  const s = ensureSession(sessionId);
  return now() - s.lastAt > FIVE_MIN;
}
function expireIfIdle(sessionId) {
  if (expired(sessionId)) {
    const s = ensureSession(sessionId);
    // 회의 포함 모든 토픽 비활성화(endedAt 기록)
    if (s.topics?.meeting?.active) {
      s.topics.meeting.active = false;
      s.topics.meeting.endedAt = now();
    }
    s.armed = false;
    s.lastAt = now();
    return true;
  }
  return false;
}
function startMeeting(sessionId) {
  const s = ensureSession(sessionId);
  s.topics.meeting = { active: true, logs: [], startedAt: now(), endedAt: null };
  touch(sessionId);
}
function stopMeeting(sessionId) {
  const s = ensureSession(sessionId);
  if (s.topics.meeting.active) {
    s.topics.meeting.active = false;
    s.topics.meeting.endedAt = now();
  }
  touch(sessionId);
}
function isMeetingActive(sessionId) {
  return !!ensureSession(sessionId).topics.meeting.active;
}
function appendMeetingLog(sessionId, role, text) {
  const s = ensureSession(sessionId);
  if (!s.topics.meeting.logs) s.topics.meeting.logs = [];
  s.topics.meeting.logs.push({ ts: now(), role, text });
}
function getMeetingLogs(sessionId) {
  return ensureSession(sessionId).topics.meeting.logs || [];
}
function isMeetingWithin1h(sessionId) {
  const t = ensureSession(sessionId).topics.meeting;
  if (!t) return false;
  if (t.active) return true;
  if (!t.endedAt) return false;
  return (now() - t.endedAt) <= ONE_HOUR;
}

// 회의/대화 제어 트리거
const RE_MEETING_START = /(회의\s*(시작|켜|on|start))/i;
const RE_MEETING_STOP  = /(회의\s*(종료|끝|끝내자|off|stop))/i;
const RE_CHAT_END      = /(^| )(대화\s*끝)( |$)/i;

// --------------------------------------------------------------

const app = express();

/** 기본 미들웨어 */
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '20mb' }));

// 라우트
app.use('/api/meeting', meetingRoute); // ESM import 사용
app.use("/api", jarvisRoute);
app.use("/api", locationRoute);

/** 요청 로그 (문제 상황 추적용) */
app.use((req, _res, next) => {
  console.log('[IN]', req.method, req.url);
  next();
});

/** 상태 확인 */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, llm: LLM_MODE, time: new Date().toISOString() });
});

/**
 * 세션별 SSE 연결 보관소
 * key: sessionId, value: ServerResponse(res)
 * busy: 세션별 동시 턴 방지용 락
 */
const clients = new Map();
const busy = new Set();

/** 세션으로 data 프레임 전송
 *  - SSE로 전송
 *  - WebSocket으로도 동일 페이로드 브로드캐스트
 */
function sendData(sessionId, obj) {
  const res = clients.get(sessionId);
  if (res) {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      console.warn('[SSE write error]', e?.message || e);
    }
  }
  // WS 병행 전송
  wsSend(sessionId, obj);
}

/** 세션으로 event 프레임 전송
 *  - SSE 이벤트 전송
 *  - WebSocket으로도 동일 페이로드 브로드캐스트
 */
function sendEvent(sessionId, event, obj) {
  const res = clients.get(sessionId);
  if (res) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      console.warn('[SSE event error]', e?.message || e);
    }
  }
  // WS에도 event명을 포함해 보내 프론트가 분기할 수 있도록 함
  wsSend(sessionId, { event, ...obj });
}

/**
 * LLM 스트리머를 세션 브로드캐스트에 연결하기 위한 writer 어댑터
 * openaiStreamChat/llamaCppStream이 res.write("data: {...}\n\n")로 보내는 포맷을 파싱해 세션으로 중계
 * 긴 답변에서 조각 경계 유실을 막기 위해 한 chunk 내 여러 이벤트를 모두 파싱한다.
 */
function makeSessionSSEWriter(sessionId, onAssistantDelta) {
  return {
    write: (chunk) => {
      try {
        const s = String(chunk);
        // 여러 event 조각을 모두 파싱하며, 마지막에 개행이 없어도 처리
        const re = /data:\s*(\{[\s\S]*?\})\s*(?:\r?\n\r?\n|$)/g;
        let m;
        while ((m = re.exec(s)) !== null) {
          try {
            const obj = JSON.parse(m[1]);
            if (typeof obj.text === 'string' && onAssistantDelta) {
              onAssistantDelta(obj.text);
            }
            sendData(sessionId, obj); // SSE + WS 동시 전송
          } catch {}
        }
      } catch {
        // 무시
      }
    },
    end: () => {
      // 채널은 계속 열어둔다. 턴 종료 신호가 필요하면 아래 사용
      // sendEvent(sessionId, 'done', {});
    },
    flushHeaders: () => {},
    setHeader: () => {},
  };
}

/**
 * 1) SSE 채널: 세션만 등록하고 열어둔다.
 *    여기서는 어떤 텍스트도 보내지 않는다. res.end()도 호출하지 않는다.
 */
app.get('/api/chat/stream', (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) return res.status(400).end();

  // SSE 필수 헤더
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 프록시 버퍼링 방지
  res.write('retry: 15000\n\n');            // 브라우저 재시도 간격 힌트
  res.flushHeaders?.();

  // 기존 세션이 있다면 교체
  clients.set(sessionId, res);
  ensureSession(sessionId);
  console.log('[SSE open]', sessionId);

  // 하트비트로 연결 유지
  const hb = setInterval(() => {
    try { res.write(':\n\n'); } catch {}
  }, 15000);

  // 연결 종료 시 정리
  req.on('close', () => {
    clearInterval(hb);
    clients.delete(sessionId);
    console.log('[SSE close]', sessionId);
  });
});

/**
 * 2) 대화 입력: 사용자 텍스트를 받아 해당 세션으로만 스트림을 푸시
 *    - 웨이크워드 강제
 *    - 5분 미사용 시 세션 초기화
 *    - "회의 시작/종료", "대화 끝" 트리거
 *    - 회의 중 발화 로그 축적
 *    - 툴 처리(maybeEmitToolEvent) 우선 → 미처리 시 LLM
 *    - 세션별 동시 턴 방지
 */
app.post('/api/chat', async (req, res) => {
  const { sessionId, text } = req.body || {};
  if (!sessionId || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid body' });
  }

  ensureSession(sessionId);

  // WebSocket만 사용하는 클라이언트를 허용하기 위해 SSE 미연결이어도 진행
  if (!clients.has(sessionId)) {
    console.warn('[WARN] no SSE client for session:', sessionId);
  }

  // 세션별 동시 턴 방지
  if (busy.has(sessionId)) {
    return res.status(429).json({ ok: false, error: 'busy', message: '이전 응답이 완료된 뒤 다시 요청해 주세요.' });
  }
  busy.add(sessionId);

  try {
    expireIfIdle(sessionId); // 5분 무활성 시 초기화
    const s = sessions.get(sessionId);

    // 디버그: 실제 들어온 발화의 정규화/매칭 상태 확인
    logWakeDebug(sessionId, text);

    // 웨이크워드 체크: armed=false 이면 반드시 필요
    if (!s.armed) {
      const { ok: woke, rest } = matchWake(text);
      if (!woke) {
        // 안내만 보내고 종료
        sendData(sessionId, { text: '대화를 시작하려면 "헤이 자비스"로 불러주세요.' });
        return res.json({ ok: true, handled: true, needWakeWord: true });
      }
      // 웨이크워드 인식 → armed
      arm(sessionId);
      sendEvent(sessionId, 'wake', { ok: true, text: '네, 말씀하세요.' });

      // "헤이 자비스"만 말한 경우 → 여기서 종료 (다음 발화 대기)
      if (!rest) {
        return res.json({ ok: true, handled: true });
      }

      // 내용이 붙어 있었다면 그걸로 계속
      req.body.text = rest;
    }

    // 이미 armed라면, 앞에 웨이크워드가 또 붙었으면 떼고 진행
    let plain = String(req.body.text ?? text);
    const stripTry = matchWake(plain);
    if (stripTry.ok) plain = stripTry.rest;

    // 트리거: 회의 시작
    if (RE_MEETING_START.test(plain)) {
      startMeeting(sessionId);
      sendEvent(sessionId, 'meeting', { type: 'meeting.start', text: '네, 회의를 경청하겠습니다. 종료하실 때 "회의 종료"라고 말씀해 주세요.' });
      return res.json({ ok: true, handled: true });
    }

    // 트리거: 회의 종료
    if (RE_MEETING_STOP.test(plain)) {
      const wasActive = isMeetingActive(sessionId);
      stopMeeting(sessionId);
      const msg = wasActive
        ? '네, 회의를 마치겠습니다. 회의 내용은 1시간 동안 기억해요. 요약을 지금 들려드릴까요, 아니면 메일로 보내드릴까요?'
        : '현재 진행 중인 회의가 없어요.';
      sendEvent(sessionId, 'meeting', { type: 'meeting.end', text: msg, within1h: isMeetingWithin1h(sessionId) });
      return res.json({ ok: true, handled: true });
    }

    // 트리거: “대화 끝” → 회의 외 슬롯 종료 안내 (룰 라우터가 별도 슬롯을 가지고 있지 않으므로 안내용)
    if (RE_CHAT_END.test(plain)) {
      sendEvent(sessionId, 'chat', { type: 'chat.end', text: '네, 현재 대화 맥락은 종료할게요. 필요하시면 다시 "헤이 자비스"로 불러주세요.' });
      return res.json({ ok: true, handled: true });
    }

    // 회의 진행 중이면 로그 축적(사용자 발화만)
    if (isMeetingActive(sessionId)) {
      appendMeetingLog(sessionId, 'user', plain);
    }

    // 2-1) 툴 이벤트 먼저 처리 (처리 시 handled=true → LLM 건너뜀)
    let handled = false;
    try {
      handled = await maybeEmitToolEvent(plain, (event, payload) => {
        sendEvent(sessionId, event, { ok: true, ...payload });
      });
    } catch (e) {
      sendData(sessionId, { text: '\n[도구 오류] ' + (e?.message || String(e)) });
      handled = true; // 도구 실패 노출 시 LLM 중복 방지
    }

    if (handled) {
      touch(sessionId);
      return res.json({ ok: true, handled: true });
    }

    // 긴 입력이면 요약본으로 치환해 LLM에 전달
    const effectiveText = await summarizeInputIfLong(plain, 1200);

    // 2-2) 세션 메모리에 사용자 발화 추가
    appendUser(sessionId, effectiveText);

    // 최근 n턴 컨텍스트 구성 (너무 길어지는 것 방지)
    const messages = getContext(sessionId, 10);

    let assistantText = '';

    // 스트리머 쓰기 어댑터
    const writer = makeSessionSSEWriter(sessionId, (delta) => {
      assistantText += delta;
    });

    if (LLM_MODE === 'openai') {
      const prompt = flattenMessages(messages);
      await openaiStreamChat(prompt, writer);
    } else if (LLM_MODE === 'llamacpp') {
      const prompt = flattenMessages(messages);
      await llamaCppStream(prompt, writer);
    } else {
      // mock 모드
      const msg = 'mock 모드 응답입니다. .env에서 LLM_MODE=openai 로 바꾸고 BASE_URL/LLM_MODEL을 설정하세요.';
      for (const ch of msg) {
        await new Promise((r) => setTimeout(r, 15));
        assistantText += ch;
        sendData(sessionId, { text: ch });
      }
    }

    // 누적된 어시스턴트 답변을 세션 메모리에 저장
    if (assistantText.trim()) {
      appendAssistant(sessionId, assistantText);
    }

    touch(sessionId);
    return res.json({ ok: true });
  } catch (err) {
    const t = (err && err.stack) ? err.stack : (err?.message || String(err));
    sendData(sessionId, { text: '\n[서버 오류] ' + t });
    return res.status(500).json({ ok: false, error: 'llm error' });
  } finally {
    busy.delete(sessionId);
  }
});

/** 디버그: 현재 열려있는 세션 목록 */
app.get('/api/debug/clients', (_req, res) => {
  res.json({ count: clients.size, sessionIds: Array.from(clients.keys()) });
});

/** 서버 시작: HTTP 서버 생성 후 WebSocket 부착 */
const server = http.createServer(app);
attachWS(server);

server.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});
