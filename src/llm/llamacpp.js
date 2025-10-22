// 코드 주석에 이모티콘은 사용하지 않습니다.
import fetch from 'node-fetch';

const BASE = process.env.LLAMACPP_BASE_URL || 'http://127.0.0.1:8080';
const N_THREADS = parseInt(process.env.LLAMACPP_N_THREADS || '4', 10);

export async function llamaCppStream(userText, res) {
  const url = `${BASE.replace(/\/$/, '')}/completion`;
  const body = {
    prompt: `SYSTEM: You are a helpful Korean voice assistant.\nUSER: ${userText}\nASSISTANT:`,
    stream: true,
    n_predict: 512,
    temperature: 0.7,
    n_threads: N_THREADS
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => '');
    throw new Error(`llama.cpp request failed: ${r.status} ${r.statusText} ${text}`);
  }

  for await (const chunk of r.body) {
    const s = chunk.toString('utf8').trim();
    if (!s) continue;
    try {
      const j = JSON.parse(s);
      if (typeof j.content === 'string') {
        res.write(`data: ${JSON.stringify({ text: j.content })}\n\n`);
      } else if (typeof j.token === 'string') {
        res.write(`data: ${JSON.stringify({ text: j.token })}\n\n`);
      }
    } catch {
      res.write(`data: ${JSON.stringify({ text: s })}\n\n`);
    }
  }
}
