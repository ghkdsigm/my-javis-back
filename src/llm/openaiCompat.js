// 코드 주석에 이모티콘은 사용하지 않습니다.
import fetch from 'node-fetch';
import { createParser } from 'eventsource-parser';

const BASE = process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1';
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'llama3.1';

export async function openaiStreamChat(userText, res) {
  const url = `${BASE.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: MODEL,
    stream: true,
    temperature: 0.7,
    messages: [
      { role: 'system', content: 'You are a helpful Korean voice assistant.' },
      { role: 'user', content: userText }
    ]
  };

  const headers = {
    'Content-Type': 'application/json'
  };
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
      if (delta) {
        res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
      }
    } catch {}
  });

  for await (const chunk of r.body) {
    const str = chunk.toString('utf8');
    parser.feed(str);
  }
}
