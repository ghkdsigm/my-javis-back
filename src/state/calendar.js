// src/state/calendar.js
// 코드 주석에 이모티콘은 사용하지 않습니다.
// @ts-check

import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "calendar.json");

/**
 * @typedef {Object} CalendarEvent
 * @property {string} id
 * @property {string} title
 * @property {string} date    // YYYY-MM-DD
 * @property {string} [time]  // HH:mm
 * @property {string} [whenText] // 사용자가 말한 원문
 * @property {string} createdAt
 * @property {string} updatedAt
 */

let loaded = false;
/** @type {CalendarEvent[]} */
let events = [];

/** 데이터 파일 로드 */
function load() {
  if (loaded) return;
  loaded = true;

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DATA_FILE)) {
      const text = fs.readFileSync(DATA_FILE, "utf8");
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) {
        events = arr;
      }
    }
  } catch (e) {
    console.error("[calendar] load error:", e);
    events = [];
  }
}

/** 데이터 파일 저장 */
function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(events, null, 2), "utf8");
  } catch (e) {
    console.error("[calendar] save error:", e);
  }
}

function nowISO() {
  return new Date().toISOString();
}

/**
 * 간단한 ID 생성기
 * @returns {string}
 */
function makeId() {
  return "evt_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * 날짜 문자열 정규화
 * - 이미 YYYY-MM-DD 형식이면 그대로 사용
 * - 없으면 오늘 날짜 사용
 * @param {string | undefined} date
 */
function normalizeDate(date) {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return date;
  }
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 시간 문자열 정규화
 * - HH:mm 또는 HH 형태를 HH:mm으로 바꾼다.
 * @param {string | undefined} time
 */
function normalizeTime(time) {
  if (!time) return "";
  const trimmed = String(time).trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{1,2}$/.test(trimmed)) {
    return String(trimmed).padStart(2, "0") + ":00";
  }
  return trimmed;
}

/**
 * 일정 추가
 * @param {{ title?: string; date?: string; time?: string; whenText?: string }} input
 * @returns {CalendarEvent}
 */
export function addEvent(input) {
  load();
  const title = String(input.title || "").trim() || "제목 없음";
  const date = normalizeDate(input.date);
  const time = normalizeTime(input.time);
  const whenText = input.whenText || "";

  const now = nowISO();
  const ev = {
    id: makeId(),
    title,
    date,
    time,
    whenText,
    createdAt: now,
    updatedAt: now,
  };

  events.push(ev);
  save();
  return ev;
}

/**
 * 일정 조회
 * - date가 있으면 해당 날짜만
 * - range === 'week' or 'month' 이면 대략 현재 기준 일주일, 한 달
 * @param {{ date?: string; range?: "day" | "week" | "month" }} params
 * @returns {CalendarEvent[]}
 */
export function listEvents(params = {}) {
  load();
  const { date, range } = params;
  const normDate = date ? normalizeDate(date) : null;

  if (!normDate && !range) {
    return [...events].sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  }

  const base = new Date();
  const baseDate = normalizeDate(
    normDate || `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(
      base.getDate()
    ).padStart(2, "0")}`
  );

  if (!range || range === "day") {
    return events.filter((e) => e.date === baseDate).sort((a, b) =>
      (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""))
    );
  }

  if (range === "week") {
    const d = new Date(baseDate);
    d.setHours(0, 0, 0, 0);
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 7);

    return events
      .filter((e) => {
        const t = new Date(e.date || baseDate);
        return t >= start && t < end;
      })
      .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  }

  if (range === "month") {
    const d = new Date(baseDate);
    const y = d.getFullYear();
    const m = d.getMonth();
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 1);

    return events
      .filter((e) => {
        const t = new Date(e.date || baseDate);
        return t >= start && t < end;
      })
      .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  }

  return [];
}

/**
 * id 또는 (date,time) 기준으로 일정 하나 찾기
 * @param {{ id?: string; date?: string; time?: string }} params
 */
function findEvent(params) {
  load();
  const { id, date, time } = params;
  if (id) {
    return events.find((e) => e.id === id) || null;
  }
  if (date && time) {
    const normDate = normalizeDate(date);
    const normTime = normalizeTime(time);
    return events.find((e) => e.date === normDate && normalizeTime(e.time) === normTime) || null;
  }
  return null;
}

/**
 * 일정 취소
 * @param {{ id?: string; date?: string; time?: string }} params
 */
export function cancelEvent(params) {
  load();
  const target = findEvent(params);
  if (!target) {
    return { ok: false, message: "취소할 일정을 찾지 못했어요." };
  }
  events = events.filter((e) => e.id !== target.id);
  save();
  return {
    ok: true,
    canceledId: target.id,
    canceled: target,
    message:
      (target.time ? `${target.date} ${target.time}` : target.date) +
      ` 일정 "${target.title}"을(를) 취소했습니다.`,
  };
}

/**
 * 일정 제목 수정
 * @param {{ id?: string; date?: string; time?: string; newTitle?: string }} params
 */
export function updateEventTitle(params) {
  load();
  const { newTitle } = params;
  const title = String(newTitle || "").trim();
  if (!title) {
    return { ok: false, message: "변경할 제목이 비어 있습니다." };
  }

  const target = findEvent(params);
  if (!target) {
    return { ok: false, message: "수정할 일정을 찾지 못했어요." };
  }

  target.title = title;
  target.updatedAt = nowISO();
  save();

  return {
    ok: true,
    updatedId: target.id,
    updated: target,
    message:
      (target.time ? `${target.date} ${target.time}` : target.date) +
      ` 일정 제목을 "${target.title}"로 변경했습니다.`,
  };
}

/**
 * 화면용 리스트 문자열
 * @param {CalendarEvent[]} items
 * @param {{ range?: "day"|"week"|"month"; date?: string }} params
 */
export function formatEventListText(items, params = {}) {
  if (!items.length) {
    if (params.range === "week") return "이번 주에 등록된 일정이 없어요.";
    if (params.range === "month") return "이번 달에 등록된 일정이 없어요.";
    return "해당 날짜에 등록된 일정이 없어요.";
  }

  const lines = items.map((e, idx) => {
    const t = e.time ? `${e.time} ` : "";
    return `${idx + 1}. ${e.date} ${t}${e.title}`;
  });

  if (params.range === "week") {
    return `이번 주 일정은 총 ${items.length}건입니다.\n` + lines.join("\n");
  }
  if (params.range === "month") {
    return `이번 달 일정은 총 ${items.length}건입니다.\n` + lines.join("\n");
  }
  return `해당 날짜 일정은 총 ${items.length}건입니다.\n` + lines.join("\n");
}
