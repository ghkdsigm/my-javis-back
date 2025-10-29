// 코드 주석에 이모티콘은 사용하지 마세요.
// @ts-check

// 세션 또는 디바이스 키로 최신 위치를 보관
const latestByKey = new Map(); // key -> { lat, lon, accuracy, heading, ts, source }
const historyByKey = new Map(); // key -> array of recent points

const MAX_HISTORY = 100;
const STALE_MS = 1000 * 60 * 10; // 10분 지나면 오래된 것으로 간주

export function setLocation(key, loc) {
  const now = Date.now();
  const point = {
    lat: Number(loc.lat),
    lon: Number(loc.lon),
    accuracy: loc.accuracy != null ? Number(loc.accuracy) : undefined,
    heading: loc.heading != null ? Number(loc.heading) : undefined,
    ts: loc.ts ? Number(loc.ts) : now,
    source: loc.source || "gps",
  };
  latestByKey.set(key, point);

  const arr = historyByKey.get(key) || [];
  arr.push(point);
  while (arr.length > MAX_HISTORY) arr.shift();
  historyByKey.set(key, arr);
  return point;
}

export function getLatest(key) {
  const p = latestByKey.get(key);
  if (!p) return null;
  const fresh = Date.now() - p.ts < STALE_MS;
  return { ...p, fresh };
}

export function getHistory(key, sinceMs = 0) {
  const arr = historyByKey.get(key) || [];
  if (!sinceMs) return arr.slice();
  return arr.filter(p => p.ts >= sinceMs);
}
