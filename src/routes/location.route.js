// 코드 주석에 이모티콘은 사용하지 마세요.
// @ts-check
import { Router } from "express";
import { setLocation, getLatest, getHistory } from "../storage/locations.js";
import { wsSend } from "../ws.js";

const router = Router();

// 클라이언트가 주기적으로 위치 업데이트
// body: { sessionId?: string, deviceId?: string, coords: { lat, lon, accuracy?, heading?, ts? }, source?: "gps"|"network" }
router.post("/location/update", (req, res) => {
  const { sessionId, deviceId, coords, source } = req.body || {};
  const key = String(sessionId || deviceId || "");
  if (!key || !coords || typeof coords.lat !== "number" || typeof coords.lon !== "number") {
    return res.status(400).json({ ok: false, error: "invalid body" });
  }
  const point = setLocation(key, { ...coords, source });

  // 실시간 구독자가 있다면 WS로 브로드캐스트
  wsSend(key, { type: "location", coords: point });

  return res.json({ ok: true, point });
});

// 마지막 위치 조회
// query: ?sessionId=... 또는 ?deviceId=...
router.get("/location/last", (req, res) => {
  const key = String(req.query.sessionId || req.query.deviceId || "");
  if (!key) return res.status(400).json({ ok: false, error: "no key" });
  const p = getLatest(key);
  if (!p) return res.status(404).json({ ok: false, error: "not found" });
  return res.json({ ok: true, point: p });
});

// 최근 히스토리 조회(선택)
// query: ?sessionId=...&sinceMs=...
router.get("/location/history", (req, res) => {
  const key = String(req.query.sessionId || req.query.deviceId || "");
  const sinceMs = req.query.sinceMs ? Number(req.query.sinceMs) : 0;
  if (!key) return res.status(400).json({ ok: false, error: "no key" });
  const arr = getHistory(key, sinceMs);
  return res.json({ ok: true, points: arr });
});

export default router;
