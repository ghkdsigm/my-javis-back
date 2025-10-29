// src/utils/embeddings.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import fetch from 'node-fetch';

const PROVIDER = (process.env.EMBEDDING_PROVIDER || 'openai').toLowerCase();
// OpenAI / llama.cpp / Ollama(OpenAI 호환) 등
const BASE = process.env.EMBEDDING_BASE_URL || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.EMBEDDING_MODEL || 'bge-m3'; // 예: 'bge-m3', 'nomic-embed-text', 'text-embedding-3-small'
const KEY   = process.env.EMBEDDING_API_KEY || '';

/** OpenAI 호환 /v1/embeddings 호출 */
async function openaiCompatEmbed(texts) {
  const r = await fetch(`${BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(KEY ? { 'Authorization': `Bearer ${KEY}` } : {}),
    },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`embedding_failed: ${r.status} ${r.statusText} ${body}`);
  }
  const j = await r.json();
  // OpenAI 호환 스펙: data: [{ embedding: number[], index: n }, ...]
  return (j?.data || []).map(d => d.embedding);
}

/** llama.cpp를 OpenAI 호환으로 띄웠다면 동일 호출 사용 */
async function llamaCppEmbed(texts) {
  return openaiCompatEmbed(texts);
}

export async function embedMany(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (PROVIDER === 'openai') return openaiCompatEmbed(texts);
  if (PROVIDER === 'llamacpp') return llamaCppEmbed(texts);
  throw new Error(`unknown_embedding_provider: ${PROVIDER}`);
}

export async function embedOne(text) {
  const [v] = await embedMany([String(text || '')]);
  return v;
}

/** 코사인 유사도 */
export function cosine(a = [], b = []) {
  let dot = 0, an = 0, bn = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    an += x * x;
    bn += y * y;
  }
  const denom = Math.sqrt(an) * Math.sqrt(bn) || 1;
  return dot / denom;
}

/** 간단 메모리 캐시 */
const memCache = new Map(); // key: text, val: float[]
export async function embedOneCached(text) {
  const key = String(text || '');
  if (memCache.has(key)) return memCache.get(key);
  const v = await embedOne(key);
  memCache.set(key, v);
  return v;
}

export function clearEmbedCache() {
  memCache.clear();
}
