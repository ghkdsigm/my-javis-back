// src/state/sessionManager.js
const FIVE_MIN = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

const HEY_PATTERNS = [
  /^ *(헤이|헤이자비스|헤이 자비스|해이|해이자비스|해이 자비스)\b/i,
  /^ *hey +jarvis(e)?\b/i,
  /^ *hey +javis\b/i,
  /^ *hey +jarvice\b/i,
];

function hasHeyPrefix(text = "") {
  const s = String(text).trim();
  return HEY_PATTERNS.some((re) => re.test(s));
}
function stripHeyPrefix(text = "") {
  let s = String(text).trim();
  for (const re of HEY_PATTERNS) {
    if (re.test(s)) {
      s = s.replace(re, "").trim();
      break;
    }
  }
  return s;
}

class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> { lastAt, topics: Map, memory: Map }
  }
  now() { return Date.now(); }

  ensure(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        lastAt: this.now(),
        // topics: meeting은 특별 취급 (listening:true/false, logs:[], endedAt:null)
        topics: new Map(),
        // short-term memories per topic
        memory: new Map(),
        // whether the session is "armed" (wake word ok)
        armed: false,
      });
    }
    return this.sessions.get(sessionId);
  }

  touch(sessionId) {
    const s = this.ensure(sessionId);
    s.lastAt = this.now();
  }

  isExpired(sessionId, ms = FIVE_MIN) {
    const s = this.ensure(sessionId);
    return this.now() - s.lastAt > ms;
  }

  expireIfIdle(sessionId) {
    if (this.isExpired(sessionId)) {
      // reset session but keep topic-local retention rules via endedAt
      this.reset(sessionId);
      return true;
    }
    return false;
  }

  arm(sessionId) {
    const s = this.ensure(sessionId);
    s.armed = true;
    this.touch(sessionId);
  }
  disarm(sessionId) {
    const s = this.ensure(sessionId);
    s.armed = false;
  }
  isArmed(sessionId) {
    return this.ensure(sessionId).armed;
  }

  // Topics
  startTopic(sessionId, topic) {
    const s = this.ensure(sessionId);
    const cur = s.topics.get(topic) || {};
    s.topics.set(topic, { ...cur, active: true, startedAt: this.now(), endedAt: null, logs: cur.logs || [] });
    this.touch(sessionId);
  }
  stopTopic(sessionId, topic) {
    const s = this.ensure(sessionId);
    const cur = s.topics.get(topic) || {};
    s.topics.set(topic, { ...cur, active: false, endedAt: this.now(), logs: cur.logs || [] });
    this.touch(sessionId);
  }
  isActive(sessionId, topic) {
    const s = this.ensure(sessionId);
    return !!(s.topics.get(topic)?.active);
  }
  getTopic(sessionId, topic) {
    return this.ensure(sessionId).topics.get(topic);
  }
  appendLog(sessionId, topic, role, text) {
    const t = this.getTopic(sessionId, topic);
    if (!t) return;
    t.logs.push({ ts: this.now(), role, text });
  }

  // Retention: keep topic logs for 1h from topic end
  prune() {
    const now = this.now();
    for (const [sid, s] of this.sessions.entries()) {
      for (const [topic, t] of s.topics.entries()) {
        if (t.endedAt && now - t.endedAt > ONE_HOUR) {
          s.topics.delete(topic);
        }
      }
    }
  }

  reset(sessionId) {
    const s = this.ensure(sessionId);
    // Disarm & close non-meeting topics; meeting remains if active? => spec상 5분 미사용이면 세션 자체 종료
    // 회의도 끊긴 것으로 처리
    for (const [topic, t] of s.topics.entries()) {
      if (t.active) t.endedAt = this.now();
      t.active = false;
    }
    s.armed = false;
    s.lastAt = this.now();
  }
}

module.exports = {
  SessionManager: new SessionManager(),
  hasHeyPrefix,
  stripHeyPrefix,
  FIVE_MIN,
  ONE_HOUR,
};
