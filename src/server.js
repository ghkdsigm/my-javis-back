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
  try { s = s.normalize('NFKC'); } catch {}
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  s = s.replace(/^[\s“”"‘’'`·・•~\-—–_=+*\[\]{}()<>〈〉〔〕【】「」『』❝❞⭐️✨💬🙂🙃👍👌🙏….,!?]+/u, '');
  s = s.trim();
  return s;
}

// 웨이크워드 매칭: 다양한 한/영 변형 + 붙여 말하기 허용
// 반환 { ok: boolean, rest: string }
function matchWake(text = "") {
  const raw = String(text ?? "");
  const s = normalizeForWake(raw);
  const lower = s.toLowerCase();
  const END = String.raw`(?:\s|$|[\p{P}\p{S}])`; // requires /u
  const patterns = [
    new RegExp(`^(?:헤이|해이)\\s*자비스${END}`, 'u'),
    new RegExp(`^(?:헤이자비스|해이자비스)${END}`, 'u'),
    new RegExp(`^hey\\s*jarvis(e)?${END}`, 'iu'),
    new RegExp(`^hey\\s*javis${END}`, 'iu'),
    new RegExp(`^hey\\s*jarvice${END}`, 'iu'),
    new RegExp(`^hey\\s*javice${END}`, 'iu'),
  ];
  for (const re of patterns) {
    const m = lower.match(re);
    if (m) {
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
const RE_MEETING_START   = /(회의\s*(시작|켜|on|start))/i;
const RE_MEETING_STOP    = /(회의\s*(종료|끝|끝내자|off|stop))/i;
const RE_MEETING_SUMMARY = /(회의).*(요약|정리|메일|보내|전송)/i;
const RE_CHAT_END        = /(^| )(대화\s*끝)( |$)/i;

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

/** 세션으로 data 프레임 전송 (SSE + WS) */
function sendData(sessionId, obj) {
  const res = clients.get(sessionId);
  if (res) {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      console.warn('[SSE write error]', e?.message || e);
    }
  }
  wsSend(sessionId, obj);
}

/** 세션으로 event 프레임 전송 (SSE + WS) */
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
  wsSend(sessionId, { event, ...obj });
}

/** LLM 스트리머를 세션 브로드캐스트에 연결하기 위한 writer 어댑터 */
function makeSessionSSEWriter(sessionId, onAssistantDelta) {
  return {
    write: (chunk) => {
      try {
        const s = String(chunk);
        const re = /data:\s*(\{[\s\S]*?\})\s*(?:\r?\n\r?\n|$)/g;
        let m;
        while ((m = re.exec(s)) !== null) {
          try {
            const obj = JSON.parse(m[1]);
            if (typeof obj.text === 'string' && onAssistantDelta) {
              onAssistantDelta(obj.text);
            }
            sendData(sessionId, obj);
          } catch {}
        }
      } catch {}
    },
    end: () => {},
    flushHeaders: () => {},
    setHeader: () => {},
  };
}

/** 1) SSE 채널: 세션만 등록하고 열어둔다. */
app.get('/api/chat/stream', (req, res) => {
  const sessionId = String(req.query.sessionId || '');
  if (!sessionId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write('retry: 15000\n\n');
  res.flushHeaders?.();

  clients.set(sessionId, res);
  ensureSession(sessionId);
  console.log('[SSE open]', sessionId);

  const hb = setInterval(() => {
    try { res.write(':\n\n'); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    clients.delete(sessionId);
    console.log('[SSE close]', sessionId);
  });
});

/**
 * 유틸: 한 발화 안에서 '회의 시작'과 '회의 종료'의 순서를 계산하고,
 *      시작~종료 구간의 본문을 회의 로그에 적재/종료까지 처리.
 * 반환: handled 여부(Boolean). true면 이 발화에서 모든 처리를 끝낸 것.
 */
function handleStartStopInOneUtterance(sessionId, plain) {
  const startMatch = plain.match(RE_MEETING_START);
  const stopMatch  = plain.match(RE_MEETING_STOP);

  if (!startMatch && !stopMatch) return false;

  const startIdx = startMatch ? startMatch.index : -1;
  const stopIdx  = stopMatch  ? stopMatch.index  : -1;

  // 케이스 1) 시작만 있음
  if (startMatch && !stopMatch) {
    startMeeting(sessionId);
    // '회의 시작' 뒤 본문을 로그에 적재
    const after = plain.slice(startIdx + startMatch[0].length).trim();
    if (after) appendMeetingLog(sessionId, 'user', after);
    sendEvent(sessionId, 'meeting', {
      type: 'meeting.start',
      text: '네, 회의를 경청하겠습니다. 종료하실 때 "회의 종료"라고 말씀해 주세요.'
    });
    return true;
  }

  // 케이스 2) 종료만 있음
  if (!startMatch && stopMatch) {
    const wasActive = isMeetingActive(sessionId);
    if (wasActive && typeof stopIdx === 'number') {
      const before = plain.slice(0, stopIdx).trim();
      if (before) appendMeetingLog(sessionId, 'user', before);
    }
    stopMeeting(sessionId);
    const msg = wasActive
      ? '네, 회의를 마치겠습니다. 회의 내용은 1시간 동안 기억해요. "회의 요약해줘"라고 하시면 정리해드릴게요.'
      : '현재 진행 중인 회의가 없어요.';
    sendEvent(sessionId, 'meeting', { type: 'meeting.end', text: msg, within1h: isMeetingWithin1h(sessionId) });
    return true;
  }

  // 케이스 3) 시작과 종료가 모두 존재
  // 3A) '회의 시작'이 먼저 나오고, 그 뒤로 본문, 그리고 '회의 종료'
  if (startIdx >= 0 && stopIdx >= 0 && startIdx < stopIdx) {
    // 시작 처리
    startMeeting(sessionId);
    const between = plain.slice(startIdx + startMatch[0].length, stopIdx).trim();
    if (between) appendMeetingLog(sessionId, 'user', between);
    // 종료 처리
    stopMeeting(sessionId);
    sendEvent(sessionId, 'meeting', {
      type: 'meeting.end',
      text: '네, 회의를 마치겠습니다. 회의 내용은 1시간 동안 기억해요. "회의 요약해줘"라고 하시면 정리해드릴게요.',
      within1h: isMeetingWithin1h(sessionId)
    });
    return true;
  }

  // 3B) '회의 종료'가 먼저이고, 이후에 '회의 시작'이 있는 비정상 케이스:
  // 안전하게 각각의 규칙으로 분리 처리 (종료 앞부분 로그 → 종료 → 그 뒤 시작 및 본문 로그)
  if (startIdx >= 0 && stopIdx >= 0 && stopIdx < startIdx) {
    // 종료 앞부분 로그 후 종료
    const wasActive = isMeetingActive(sessionId);
    if (wasActive) {
      const before = plain.slice(0, stopIdx).trim();
      if (before) appendMeetingLog(sessionId, 'user', before);
    }
    stopMeeting(sessionId);
    sendEvent(sessionId, 'meeting', {
      type: 'meeting.end',
      text: wasActive
        ? '네, 회의를 마치겠습니다. 회의 내용은 1시간 동안 기억해요.'
        : '현재 진행 중인 회의가 없어요.',
      within1h: isMeetingWithin1h(sessionId)
    });

    // 그 뒤에 다시 '회의 시작' 처리 (재개)
    startMeeting(sessionId);
    const after = plain.slice(startIdx + startMatch[0].length).trim();
    if (after) appendMeetingLog(sessionId, 'user', after);
    sendEvent(sessionId, 'meeting', {
      type: 'meeting.start',
      text: '네, 회의를 경청하겠습니다. 종료하실 때 "회의 종료"라고 말씀해 주세요.'
    });

    return true;
  }

  return false;
}

/**
 * 2) 대화 입력: 사용자 텍스트를 받아 해당 세션으로만 스트림을 푸시
 *    - 웨이크워드 강제
 *    - 5분 미사용 시 세션 초기화
 *    - "회의 시작/종료/요약", "대화 끝" 트리거
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

  if (!clients.has(sessionId)) {
    console.warn('[WARN] no SSE client for session:', sessionId);
  }

  if (busy.has(sessionId)) {
    return res.status(429).json({ ok: false, error: 'busy', message: '이전 응답이 완료된 뒤 다시 요청해 주세요.' });
  }
  busy.add(sessionId);

  try {
    expireIfIdle(sessionId);
    const s = sessions.get(sessionId);

    // 웨이크워드 디버그
    logWakeDebug(sessionId, text);

    // 웨이크워드 체크
    if (!s.armed) {
      const { ok: woke, rest } = matchWake(text);
      if (!woke) {
        sendData(sessionId, { text: '대화를 시작하려면 "헤이 자비스"로 불러주세요.' });
        return res.json({ ok: true, handled: true, needWakeWord: true });
      }
      arm(sessionId);
      sendEvent(sessionId, 'wake', { ok: true, text: '네, 말씀하세요.' });
      if (!rest) {
        return res.json({ ok: true, handled: true });
      }
      req.body.text = rest;
    }

    // 이미 armed라면 웨이크워드 다시 붙은 경우 제거
    let plain = String(req.body.text ?? text);
    const stripTry = matchWake(plain);
    if (stripTry.ok) plain = stripTry.rest;

    // === 한 발화 안에서 '회의 시작'/'회의 종료'를 모두 처리 (본문 적재 포함) ===
    if (handleStartStopInOneUtterance(sessionId, plain)) {
      return res.json({ ok: true, handled: true });
    }

    // (NEW) 회의 요약/정리/메일
    // (NEW) 회의 요약/정리/메일
    if (RE_MEETING_SUMMARY.test(plain)) {
      const within = isMeetingWithin1h(sessionId);
      const logs = getMeetingLogs(sessionId);
      if (!within || !logs || logs.length === 0) {
        sendEvent(sessionId, 'meeting', {
          type: 'meeting.summary.none',
          text: '최근 한 시간 이내 회의 기록을 찾지 못했습니다. "회의 시작"으로 새 회의를 시작해 주세요.'
        });
        return res.json({ ok: true, handled: true });
      }

      const transcript = logs.map(l => {
        const who = l.role === 'user' ? '사용자' : '자비스';
        return `[${who}] ${l.text}`;
      }).join('\n');

      let summary = '';
      const writer = {
        write: (chunk) => {
          try {
            const s = String(chunk);
            const re = /data:\s*(\{[\s\S]*?\})\s*(?:\r?\n\r?\n|$)/g;
            let m;
            while ((m = re.exec(s)) !== null) {
              const obj = JSON.parse(m[1]);
              if (typeof obj.text === 'string') summary += obj.text;
            }
          } catch {}
        },
        end: () => {},
        flushHeaders: () => {},
        setHeader: () => {},
      };

      // ✅ 요약 전용 프롬프트를 "문자열"로 합쳐서 llamaCppStream에 전달
      const summaryInstruction =
        '다음 회의 대화를 간결하고 구조적으로 요약해줘. ' +
        '액션아이템(To-Do), 의사결정사항, 쟁점/리스크, 담당자/마감일을 항목별로 목록화하고, ' +
        '필요시 불명확한 부분은 "확인 필요"로 표시해.';

      const userTextForLlama =
        `${summaryInstruction}\n\n` +
        `=== 회의 대화 원문 ===\n${transcript}\n\n` +
        `=== 출력 형식 가이드 ===\n` +
        `- 요약\n- 의사결정\n- 액션아이템(담당자/마감일)\n- 쟁점/리스크\n- 확인 필요`;

      // ⬇⬇⬇ 여기서 "무조건" llamaCppStream 사용 (메인이 openai여도 강제)
      await llamaCppStream(userTextForLlama, writer, { noTemporalShortcut: true });

      const textOut = summary?.trim() || '요약을 생성하지 못했습니다.';
      sendEvent(sessionId, 'meeting', {
        type: 'meeting.summary',
        text: textOut
      });
      return res.json({ ok: true, handled: true });
    }


    // “대화 끝”
    if (RE_CHAT_END.test(plain)) {
      sendEvent(sessionId, 'chat', { type: 'chat.end', text: '네, 현재 대화 맥락은 종료할게요. 필요하시면 다시 "헤이 자비스"로 불러주세요.' });
      return res.json({ ok: true, handled: true });
    }

    // 회의 진행 중이면 로그 축적(사용자 발화만)
    if (isMeetingActive(sessionId)) {
      appendMeetingLog(sessionId, 'user', plain);
    }

    // 2-1) 툴 이벤트 먼저 처리
    let handled = false;
    try {
      handled = await maybeEmitToolEvent(plain, (event, payload) => {
        sendEvent(sessionId, event, { ok: true, ...payload });
      });
    } catch (e) {
      sendData(sessionId, { text: '\n[도구 오류] ' + (e?.message || String(e)) });
      handled = true;
    }

    if (handled) {
      touch(sessionId);
      return res.json({ ok: true, handled: true });
    }

    // 긴 입력이면 요약본으로 치환해 LLM에 전달
    const effectiveText = await summarizeInputIfLong(plain, 1200);

    // 세션 메모리에 사용자 발화 추가
    appendUser(sessionId, effectiveText);

    // 최근 n턴 컨텍스트 구성
    const messages = getContext(sessionId, 10);

    let assistantText = '';
    const writer2 = makeSessionSSEWriter(sessionId, (delta) => {
      assistantText += delta;
    });

    if (LLM_MODE === 'openai') {
      const prompt = flattenMessages(messages);
      await openaiStreamChat(prompt, writer2);
    } else if (LLM_MODE === 'llamacpp') {
      const prompt = flattenMessages(messages);
      await llamaCppStream(prompt, writer2);
    } else {
      const msg = 'mock 모드 응답입니다. .env에서 LLM_MODE=openai 로 바꾸고 BASE_URL/LLM_MODEL을 설정하세요.';
      for (const ch of msg) {
        await new Promise((r) => setTimeout(r, 15));
        assistantText += ch;
        sendData(sessionId, { text: ch });
      }
    }

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
