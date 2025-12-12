// src/profile/profileRagStore.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import { buildTfidfIndex, vectorize, cosineSimilarity } from "../llm/embeddings.js";
import userProfile from "./userProfile.json" assert { type: "json" };

/**
 * @typedef {Object} ProfileChunk
 * @property {string} id        // userProfile.json 안에서의 경로(예: "basic.job", "favorites.foods.0")
 * @property {string} text      // 실제 한 줄 설명 텍스트
 * @property {string} [tag]     // personality / job / food / music / activity / default 등
 */

/**
 * 경로 문자열을 보고 대략적인 태그를 추론한다.
 * @param {string} path
 * @returns {string | undefined}
 */
function detectTagFromPath(path) {
  const p = String(path || "").toLowerCase();

  if (p.includes("job") || p.includes("직업") || p.includes("career")) {
    return "job";
  }
  if (
    p.includes("character") ||
    p.includes("성격") ||
    p.includes("strength") ||
    p.includes("weakness")
  ) {
    return "personality";
  }
  if (
    p.includes("food") ||
    p.includes("음식") ||
    p.includes("menu") ||
    p.includes("meal")
  ) {
    return "food";
  }
  if (
    p.includes("music") ||
    p.includes("노래") ||
    p.includes("playlist") ||
    p.includes("bgm")
  ) {
    return "music";
  }
  if (
    p.includes("hobby") ||
    p.includes("활동") ||
    p.includes("취미") ||
    p.includes("activity")
  ) {
    return "activity";
  }

  return "default";
}

/**
 * 발화 query 안에서 의도 태그를 추론한다.
 * 이건 searchProfile 안에서, 점수에 가중치를 줄 때 사용한다.
 * @param {string} query
 * @returns {string | undefined}
 */
function detectTagFromQuery(query) {
  const q = String(query || "");

  if (/(직업|커리어|하는 일|업무|회사)/.test(q)) {
    return "job";
  }
  if (/(성격|성향|강점|약점|장점|단점|어떤 사람)/.test(q)) {
    return "personality";
  }
  if (/(음식|밥|메뉴|먹는 거|식사|안주)/.test(q)) {
    return "food";
  }
  if (/(노래|음악|플레이리스트|뮤직|BGM)/i.test(q)) {
    return "music";
  }
  if (/(취미|취향|좋아하는 활동|놀 때)/.test(q)) {
    return "activity";
  }

  return undefined;
}

/**
 * userProfile.json 전체를 순회하면서 ProfileChunk 배열로 변환한다.
 * 문자열이면 전부 조각으로 저장한다.
 * @param {any} profile
 * @returns {ProfileChunk[]}
 */
function buildChunksFromProfile(profile) {
  /** @type {ProfileChunk[]} */
  const chunks = [];
  const seen = new Set();

  /**
   * @param {string} id
   * @param {string} text
   * @param {string | undefined} tag
   */
  function addChunk(id, text, tag) {
    const t = String(text || "").trim();
    if (!t) return;

    const key = id + "::" + t;
    if (seen.has(key)) return;
    seen.add(key);

    chunks.push({
      id,
      text: t,
      tag: tag || detectTagFromPath(id),
    });
  }

  /**
   * @param {any} value
   * @param {string[]} pathParts
   */
  function walk(value, pathParts) {
    if (value == null) return;

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const id = pathParts.join(".");
      addChunk(id, String(value), detectTagFromPath(id));
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((v, idx) => {
        walk(v, pathParts.concat(String(idx)));
      });
      return;
    }

    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        walk(v, pathParts.concat(String(k)));
      }
      return;
    }
  }

  walk(profile, []);

  return chunks;
}

/** @type {ProfileChunk[]} */
const PROFILE_SNIPPETS = buildChunksFromProfile(userProfile);

// TF-IDF 인덱스는 서버 시작 시 한 번만 생성한다.
const TFIDF_INDEX = buildTfidfIndex(
  PROFILE_SNIPPETS.map((c) => ({ id: c.id, text: c.text }))
);

// 미리 각 조각의 벡터도 만들어 둔다.
const PROFILE_VECTORS = PROFILE_SNIPPETS.map((c) => ({
  id: c.id,
  vec: vectorize(c.text, TFIDF_INDEX),
  chunk: c,
}));

/**
 * TF-IDF 기반 프로필 검색
 *
 * @param {string} query
 * @returns {Promise<ProfileChunk[]>}
 */
export async function searchProfile(query) {
    const q = String(query || "").trim();
    if (!q) return [];
  
    const qVec = vectorize(q, TFIDF_INDEX);
    const intentTag = detectTagFromQuery(q);
  
    const scored = [];
  
    for (const item of PROFILE_VECTORS) {
      let score = cosineSimilarity(qVec, item.vec);
      if (score <= 0) continue;
  
      if (intentTag && item.chunk.tag) {
        if (item.chunk.tag === intentTag) {
          score *= 1.8;
        } else if (item.chunk.tag !== "default") {
          score *= 0.7;
        }
      }
  
      scored.push({ score, chunk: item.chunk });
    }
  
    // 1) 점수 기반 후보가 있으면 상위 5개 사용
    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 5);
      return top.map((s) => s.chunk);
    }
  
    // 2) 점수 기반 후보가 전혀 없으면, 태그 기반 fallback
    if (intentTag) {
      const byTag = PROFILE_SNIPPETS.filter((c) => c.tag === intentTag);
      if (byTag.length > 0) {
        return byTag.slice(0, 5);
      }
    }
  
    // 3) 태그도 없으면 그냥 전체 프로필에서 상위 몇 개 반환
    return PROFILE_SNIPPETS.slice(0, 5);
  }
  
