// 코드 주석에 이모티콘은 사용하지 않습니다.
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { openaiStreamChat } from './llm/openaiCompat.js';
import { llamaCppStream } from './llm/llamacpp.js';
import { maybeEmitToolEvent } from './tools/router.js';

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const LLM_MODE = (process.env.LLM_MODE || 'openai').toLowerCase();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, llm: LLM_MODE, time: new Date().toISOString() });
});

app.get('/api/chat/stream', async (req, res) => {
  const text = String(req.query.text || '');
  const sessionId = String(req.query.sessionId || 'android');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // 간단한 룰 기반 툴 이벤트(선행)
  maybeEmitToolEvent(text, res);

  try {
    if (LLM_MODE === 'openai') {
      await openaiStreamChat(text, res);
    } else if (LLM_MODE === 'llamacpp') {
      await llamaCppStream(text, res);
    } else {
      const msg = 'mock 모드 응답입니다. .env에서 LLM_MODE=openai 로 바꾸고 BASE_URL/LLM_MODEL을 설정하세요.';
      for (const ch of msg) {
        await new Promise(r => setTimeout(r, 20));
        res.write(`data: ${JSON.stringify({ text: ch })}\n\n`);
      }
    }
  } catch (err) {
    const t = (err && err.stack) ? err.stack : (err?.message || String(err));
    res.write(`data: ${JSON.stringify({ text: "\n[서버 오류] " + t })}\n\n`);
  } finally {
    res.end();
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT}`);
});
