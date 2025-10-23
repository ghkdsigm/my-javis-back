// JARVIS BACKEND/src/server.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import 'dotenv/config';
import express from 'express';
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

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const LLM_MODE = (process.env.LLM_MODE || 'openai').toLowerCase();

const app = express();

/** 기본 미들웨어 */
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '20mb' }));

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
  // WS 병행 전송
  wsSend(sessionId, obj);
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
 *    2-1) 툴 처리(maybeEmitToolEvent) → 처리되면 LLM은 건너뜀
 *    2-2) 미처리 시 세션 메모리 기반으로 LLM 스트림 실행
 *    세션별 동시 턴 방지를 위해 busy 락으로 직렬화한다.
 */
app.post('/api/chat', async (req, res) => {
  const { sessionId, text } = req.body || {};
  if (!sessionId || typeof text !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid body' });
  }

  // WebSocket만 사용하는 클라이언트를 허용하기 위해 SSE 미연결이어도 진행
  if (!clients.has(sessionId)) {
    console.warn('[WARN] no SSE client for session:', sessionId);
    // 필요 시 409 반환하도록 아래를 복구할 수 있다.
    // return res.status(409).json({ ok: false, error: 'no sse stream', needStream: true });
  }

  // 세션별 동시 턴 방지
  if (busy.has(sessionId)) {
    return res.status(429).json({ ok: false, error: 'busy', message: '이전 응답이 완료된 뒤 다시 요청해 주세요.' });
  }
  busy.add(sessionId);

  try {
    // 2-1) 툴 이벤트 먼저 처리 (처리 시 handled=true → LLM 건너뜀)
    let handled = false;
    try {
      handled = await maybeEmitToolEvent(text, (event, payload) => {
        sendEvent(sessionId, event, { ok: true, ...payload });
        if (payload?.text && typeof payload.text === 'string') {
          sendData(sessionId, { text: payload.text });
        }
      });
    } catch (e) {
      sendData(sessionId, { text: '\n[도구 오류] ' + (e?.message || String(e)) });
      handled = true; // 도구 실패 노출 시 LLM 중복 방지
    }

    if (handled) {
      return res.json({ ok: true, handled: true });
    }

    // 긴 입력이면 요약본으로 치환해 LLM에 전달
    const effectiveText = await summarizeInputIfLong(text, 1200);

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
      // messages 배열을 직접 받는 구현이라면 아래를 사용
      // await openaiStreamChat({ messages }, writer);

      // 현재 text만 받는 구현일 경우 평탄화
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
