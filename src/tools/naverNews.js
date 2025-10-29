// src/tools/naverNews.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import fetch from 'node-fetch';

const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';
const DISPLAY = parseInt(process.env.NAVER_NEWS_DISPLAY || '8', 10);
const SORT = process.env.NAVER_NEWS_SORT || 'sim'; // 'sim' | 'date'

function requireCreds() {
  if (!NAVER_ID || !NAVER_SECRET) {
    throw new Error('네이버 API 자격증명이 설정되지 않았습니다. .env의 NAVER_CLIENT_ID, NAVER_CLIENT_SECRET을 확인하세요.');
  }
}

function buildHeaders() {
  return {
    'X-Naver-Client-Id': NAVER_ID,
    'X-Naver-Client-Secret': NAVER_SECRET,
  };
}

function sanitize(htmlLike) {
  return String(htmlLike || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * 네이버 뉴스 검색
 * @param {string} query
 * @returns {Promise<Array<{idx:number,title:string,desc:string,originallink:string,link:string,pubDate:string}>>}
 */
export async function searchNews(query) {
  requireCreds();
  const q = encodeURIComponent(query || '뉴스');
  const url = `https://openapi.naver.com/v1/search/news.json?query=${q}&display=${DISPLAY}&sort=${SORT}`;
  const r = await fetch(url, { headers: buildHeaders() });
  if (!r.ok) throw new Error(`Naver news http ${r.status}`);
  const json = await r.json();
  const items = (json?.items || []).map((it, idx) => ({
    idx: idx + 1,
    title: sanitize(it.title),
    desc: sanitize(it.description || ''),
    originallink: it.originallink || '',
    link: it.link || '',
    pubDate: it.pubDate || '',
  }));
  return items;
}

/**
 * 키워드로 기사 선택. 없으면 첫 번째 반환.
 * @param {Array} items
 * @param {string} keyword
 */
export function pickByKeyword(items, keyword) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const k = String(keyword || '').trim();
  if (!k) return items[0] || null;
  const lower = k.toLowerCase();
  const hit = items.find(v =>
    v.title.toLowerCase().includes(lower) ||
    v.desc.toLowerCase().includes(lower)
  );
  return hit || items[0] || null;
}

/**
 * 간단 요약. 프로젝트에 summarize 유틸이 있으면 우선 사용, 없으면 보수적 축약.
 * @param {{title:string, desc:string, link:string, originallink:string}} item
 * @returns {Promise<string>}
 */
export async function summarizeArticle(item) {
  const base = `제목: ${item.title}\n요약: ${item.desc}\n링크: ${item.link || item.originallink}`;
  // 선택적 summarize 사용
  try {
    const mod = await import('../utils/summarize.js').catch(() => null);
    if (mod && typeof mod.summarizeInputIfLong === 'function') {
      return await mod.summarizeInputIfLong(base, 800);
    }
  } catch (_) {
    // 없어도 무시
  }
  // 폴백: 길이 제한을 둔 안전한 축약
  const maxLen = 500;
  return base.length > maxLen ? (base.slice(0, maxLen) + '...') : base;
}
