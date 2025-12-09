// src/tools/jarvisTools.js
// 코드 주석에 이모티콘은 사용하지 마세요.
// @ts-check
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { wsSend } from "../ws.js";
import fetch from "node-fetch";
import {
  addEvent,
  listEvents,
  cancelEvent,
  updateEventTitle
} from "../state/calendar.js";

/**
 * 날짜를 YYYY-MM-DD 문자열로 변환
 * @param {Date} dateObj
 */
function toYMD(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 날짜에 일정 일수 더하기
 * @param {Date} dateObj
 * @param {number} n
 */
function addDays(dateObj, n) {
  const d = new Date(dateObj.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * 한국어 요일 텍스트에서 요일 인덱스 추출 (0=일,1=월,...,6=토)
 * @param {string} when
 * @returns {number | null}
 */
function parseKoreanWeekday(when) {
  if (!when) return null;
  const m = when.match(/(일|월|화|수|목|금|토)요일?/);
  if (!m) return null;
  const ch = m[1];
  const map = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
  return map[ch] ?? null;
}

/**
 * 발화 텍스트(when)와 명시적 date를 기반으로 날짜 결정
 * - options.fallbackToToday === true 면 최종적으로 못 알아들었을 때 오늘 날짜 반환
 * - false 면 null 반환해서 상위 로직이 안전하게 처리하도록 한다.
 *
 * @param {string | undefined} when
 * @param {string | undefined} explicitDate
 * @param {{ fallbackToToday?: boolean }} [options]
 * @returns {string | null}
 */
function resolveDateFromWhen(when, explicitDate, options = { fallbackToToday: true }) {
  const fallbackToToday = options.fallbackToToday ?? true;

  // 1) LLM이 이미 명확한 날짜를 줬으면 그대로 사용
  if (explicitDate && /^\d{4}-\d{2}-\d{2}$/.test(explicitDate)) {
    return explicitDate;
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayYMD = toYMD(now);

  if (!when || !when.trim()) {
    return fallbackToToday ? todayYMD : null;
  }

  const text = String(when);

  // 오늘 / 내일 / 모레
  if (text.includes("오늘")) {
    return todayYMD;
  }
  if (text.includes("내일")) {
    return toYMD(addDays(now, 1));
  }
  if (text.includes("모레")) {
    return toYMD(addDays(now, 2));
  }

  // 요일 기준
  const weekday = parseKoreanWeekday(text);

  if (weekday != null) {
    const todayDow = now.getDay();

    // "다음주 월요일" 같이 '다음주' 들어간 경우
    if (/다음\s*주/.test(text)) {
      // 다음 주 시작(다음주 일요일) 기준으로 요일 계산
      const nextWeekStart = addDays(now, 7 - todayDow);
      const target = addDays(nextWeekStart, weekday);
      return toYMD(target);
    }

    // 그냥 "금요일" 같이 요일만 있는 경우:
    // → 이번 주 기준 앞으로 다가오는 그 요일
    let diff = weekday - todayDow;
    if (diff < 0) {
      diff += 7;
    }
    const target = addDays(now, diff);
    return toYMD(target);
  }

  // 여기까지도 못 잡으면
  return fallbackToToday ? todayYMD : null;
}

/**
 * 요일 인덱스(0~6)를 한국어 요일 텍스트로 변환
 * @param {number} dow
 */
function formatKoreanWeekday(dow) {
  const map = ["일", "월", "화", "수", "목", "금", "토"];
  return map[dow] ?? "";
}

/**
 * 하루 일정 목록을 "1. 10:00 - 회의" 형식으로 변환
 * @param {import("../state/calendar.js").CalendarEvent[]} events
 */
function buildDayScheduleLines(events) {
  if (!events.length) return "등록된 일정이 없습니다.";
  const lines = events.map((e, idx) => {
    const timePart = e.time ? `${e.time} - ` : "";
    return `${idx + 1}. ${timePart}${e.title}`;
  });
  return lines.join("\n");
}

/**
 * 주/월 단위 일정 목록을 날짜별로 묶어 출력 문자열 생성
 * @param {import("../state/calendar.js").CalendarEvent[]} events
 */
function buildWeekOrMonthScheduleLines(events) {
  if (!events.length) return "등록된 일정이 없습니다.";

  const grouped = events.reduce((acc, ev) => {
    if (!acc[ev.date]) acc[ev.date] = [];
    acc[ev.date].push(ev);
    return acc;
  }, /** @type {Record<string, import("../state/calendar.js").CalendarEvent[]>} */ ({}));

  const dates = Object.keys(grouped).sort();
  const chunks = [];

  for (const date of dates) {
    const d = new Date(date);
    const dow = formatKoreanWeekday(d.getDay());
    const header = `[${date} (${dow})]`;
    const lines = grouped[date]
      .sort((a, b) => (a.time || "").localeCompare(b.time || ""))
      .map((e, idx) => {
        const timePart = e.time ? `${e.time} - ` : "";
        return `${idx + 1}. ${timePart}${e.title}`;
      });

    chunks.push(header);
    chunks.push(...lines);
    chunks.push(""); // 날짜 사이 공백 줄
  }

  return chunks.join("\n").trimEnd();
}

// 실제 단말 제어는 ws.js의 브리지로 교체하면 된다.
async function sendToPhone(type, payload) {
  return { ok: true, type, payload };
}

/**
 * Hailuo(MiniMax) TTS v2 호출
 * - 기본 엔드포인트는 minimax.chat 도메인의 /v1/t2a_v2
 * - v2 스키마는 voice_setting, audio_setting 중첩 필드 사용
 *
 * @typedef {Object} TtsNormalized
 * @property {boolean} ok
 * @property {"url"|"base64"=} type
 * @property {string=} url
 * @property {string=} base64
 * @property {string=} mime
 * @property {string=} error
 */

/**
 * @param {string} text
 * @param {Object} [opts]
 * @returns {Promise<TtsNormalized>}
 */
async function hailuoTtsRequest(text, opts = {}) {
  const base = process.env.MINIMAX_TTS_BASE || "https://api.minimax.io/v1/t2a_v2";
  const groupId = process.env.MINIMAX_GROUP_ID;
  const apiKey = process.env.MINIMAX_API_KEY;

  if (!groupId || !apiKey) {
    return { ok: false, error: "MiniMax credentials missing (MINIMAX_GROUP_ID / MINIMAX_API_KEY)" };
  }

  const url = `${String(base).replace(/\/+$/, "")}?GroupId=${encodeURIComponent(groupId)}`;

  const {
    model = "speech-02-turbo",
    stream = false,
    output_format = "url",
    voice_id = "audiobook_female_1",
    speed = 1.0,
    pitch = 0,
    vol = 1.0,
    format = "mp3",
    sample_rate = 24000,
    bitrate = 128000,
    channel = 1,
    subtitle_enable = false
  } = opts || {};

  const body = {
    model,
    text,
    stream,
    output_format,
    voice_setting: { voice_id, speed, pitch, vol },
    audio_setting: { format, sample_rate, bitrate, channel },
    subtitle_enable
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    return { ok: false, error: `MiniMax TTS HTTP ${r.status} ${detail}` };
  }

  const json = await r.json().catch(() => ({}));

  const statusCode = json?.base_resp?.status_code;
  const audioFromData = json?.data?.audio;
  if (statusCode === 0 && typeof audioFromData === "string" && audioFromData.startsWith("http")) {
    return { ok: true, type: "url", url: audioFromData };
  }

  const audioUrl = json?.audio_url || json?.url;
  const base64 = json?.base64 || json?.audio;
  if (audioUrl) return { ok: true, type: "url", url: audioUrl };
  if (base64) return { ok: true, type: "base64", base64, mime: "audio/mp3" };

  const errMsg = json?.base_resp?.status_msg || "Unexpected MiniMax response";
  return { ok: false, error: errMsg, data: json };
}

export const openAppTool = new DynamicStructuredTool({
  name: "open_app",
  description: "모바일 앱 실행 또는 앱 내 검색",
  schema: z.object({
    app: z.string(),
    query: z.string().optional()
  }),
  func: async (input) => {
    const r = await sendToPhone("OPEN_APP", input);
    return JSON.stringify(r);
  }
});

export const playMediaTool = new DynamicStructuredTool({
  name: "play_media",
  description: "음악/영상 재생",
  schema: z.object({
    provider: z.enum(["YouTube", "Melon", "Spotify"]).optional(),
    query: z.string()
  }),
  func: async (input) => {
    const r = await sendToPhone("PLAY_MEDIA", {
      provider: input.provider || "YouTube",
      query: input.query
    });
    return JSON.stringify(r);
  }
});

export const webSearchTool = new DynamicStructuredTool({
  name: "web_search",
  description: "간단한 웹검색",
  schema: z.object({
    q: z.string()
  }),
  func: async (input) => {
    return JSON.stringify({
      results: [{ title: "검색 예시", url: "https://example.com?q=" + encodeURIComponent(input.q) }]
    });
  }
});

export const calendarTool = new DynamicStructuredTool({
  name: "calendar_add",
  description: "개인 일정 관리 도구. 일정 추가, 조회, 취소, 수정 기능을 수행한다.",
  schema: z.object({
    action: z.enum(["add", "list", "cancel", "update"]).default("add"),
    title: z.string().optional(),
    when: z.string().optional(),
    date: z.string().optional(),
    time: z.string().optional(),
    id: z.string().optional(),
    newTitle: z.string().optional()
  }),
  func: async (input) => {
    const action = input.action || "add";

    // 1) 일정 추가
    if (action === "add") {
      const resolvedDate = resolveDateFromWhen(input.when || "", input.date, {
        fallbackToToday: true
      });

      // title이 비어 있으면 when에서 제목 후보를 뽑아서 사용
      let title = (input.title || "").trim();

      if (!title && input.when) {
        const raw = String(input.when);
        let t = raw;

        // 1) 존칭/호칭 제거
        t = t.replace(/마스터[,\s]?/g, "");

        // 2) 날짜 관련 표현 제거
        t = t.replace(/오늘|내일|모레|이번\s*주|이번주|다음\s*주|다음주|이번\s*달|이번달/g, "");

        // 3) 오전/오후 + 시/분 표현 제거
        t = t.replace(/오전|오후/g, "");
        t = t.replace(/\d{1,2}\s*시(\s*\d{1,2}\s*분)?/g, "");

        // 4) 일정 관련 명사/동사 제거
        t = t.replace(/일정|스케줄|약속|예약/g, "");
        t = t.replace(/잡아줘|잡아 줄|예약해줘|예약 해줘|예약해 줘|등록해줘|등록 해줘|추가해줘|추가 해줘/g, "");
        t = t.replace(/해줘|해 줘/g, "");

        // 5) 남은 문장부호 정리
        t = t.replace(/[.,!?]/g, "");

        t = t.trim();

        if (t) {
          title = t;
        }
      }

      const ev = addEvent({
        title,
        date: resolvedDate || undefined,
        time: input.time,
        whenText: input.when
      });

      const events = listEvents({ date: ev.date, range: "day" });

      let dayLabel = `${ev.date} 일정은 다음과 같습니다`;
      if (input.when && input.when.includes("오늘")) {
        dayLabel = "오늘의 일정은 다음과 같습니다";
      } else if (input.when && input.when.includes("내일")) {
        dayLabel = "내일 일정은 다음과 같습니다";
      }

      const scheduleLines = buildDayScheduleLines(events);

      const messagePrefix = `네, 마스터. ${input.when || (ev.date + (ev.time ? " " + ev.time : ""))}에 "${ev.title}" 일정을 추가했습니다.`;
      const message = messagePrefix + `\n\n변경된 ${dayLabel}:\n\n` + scheduleLines;

      return JSON.stringify({
        ok: true,
        action: "add",
        event: ev,
        events,
        message
      });
    }
    

    // 2) 일정 조회
    if (action === "list") {
      const resolvedDate = resolveDateFromWhen(input.when || "", input.date, {
        fallbackToToday: true
      });

      let range = "day";
      if (input.when && /이번\s*주/.test(input.when)) range = "week";
      if (input.when && /이번\s*달|이번\s*월/.test(input.when)) range = "month";

      const events = listEvents({
        date: resolvedDate || undefined,
        range: /** @type {"day"|"week"|"month"} */ (range)
      });

      let message;
      if (range === "day") {
        let dayLabel = `${resolvedDate} 일정은 다음과 같습니다`;
        if (input.when && input.when.includes("오늘")) {
          dayLabel = "오늘의 일정은 다음과 같습니다";
        } else if (input.when && input.when.includes("내일")) {
          dayLabel = "내일 일정은 다음과 같습니다";
        }

        const scheduleLines = buildDayScheduleLines(events);
        message = `마스터, ${dayLabel}:\n\n${scheduleLines}`;
      } else {
        const scheduleLines = buildWeekOrMonthScheduleLines(events);
        if (range === "week") {
          message = `마스터, 이번 주 일정은 다음과 같습니다:\n\n${scheduleLines}`;
        } else {
          message = `마스터, 이번 달 일정은 다음과 같습니다:\n\n${scheduleLines}`;
        }
      }

      return JSON.stringify({
        ok: true,
        action: "list",
        events,
        message
      });
    }

    // 3) 일정 취소
    if (action === "cancel") {
      const resolvedDate = resolveDateFromWhen(input.when || "", input.date, {
        fallbackToToday: false
      });

      if (!resolvedDate && !input.id) {
        return JSON.stringify({
          ok: false,
          action: "cancel",
          message:
            "어느 날의 일정을 취소해야 할지 잘 이해하지 못했어요. '오늘', '내일', '이번 주 금요일'처럼 다시 말해 주세요."
        });
      }

      const result = cancelEvent({
        id: input.id,
        date: resolvedDate || undefined,
        time: input.time
      });

      const events = resolvedDate ? listEvents({ date: resolvedDate, range: "day" }) : [];
      const scheduleLines = resolvedDate ? buildDayScheduleLines(events) : "";

      let label;
      if (input.when && input.when.includes("오늘")) {
        label = "오늘의 남은 일정은 다음과 같습니다";
      } else if (input.when && input.when.includes("내일")) {
        label = "내일 일정은 다음과 같습니다";
      } else if (resolvedDate) {
        label = `${resolvedDate} 일정은 다음과 같습니다`;
      }

      const extra =
        resolvedDate && events.length > 0
          ? `\n\n${label}:\n\n${scheduleLines}`
          : resolvedDate
          ? "\n\n해당 날짜에 남은 일정은 없습니다."
          : "";

      const message = (result.message || "") + extra;

      return JSON.stringify({
        ok: result.ok,
        action: "cancel",
        ...result,
        events,
        message
      });
    }

    // 4) 일정 제목 수정
    if (action === "update") {
      const resolvedDate = resolveDateFromWhen(input.when || "", input.date, {
        fallbackToToday: false
      });

      if (!resolvedDate && !input.id) {
        return JSON.stringify({
          ok: false,
          action: "update",
          message:
            "어느 날의 어떤 일정을 수정해야 할지 잘 이해하지 못했어요. '오늘 8시 약속', '내일 오전 10시 일정'처럼 다시 말해 주세요."
        });
      }

      const result = updateEventTitle({
        id: input.id,
        date: resolvedDate || undefined,
        time: input.time,
        newTitle: input.newTitle || input.title
      });

      const events = resolvedDate ? listEvents({ date: resolvedDate, range: "day" }) : [];
      const scheduleLines = resolvedDate ? buildDayScheduleLines(events) : "";

      let label;
      if (input.when && input.when.includes("오늘")) {
        label = "오늘의 일정은 다음과 같습니다";
      } else if (input.when && input.when.includes("내일")) {
        label = "내일 일정은 다음과 같습니다";
      } else if (resolvedDate) {
        label = `${resolvedDate} 일정은 다음과 같습니다`;
      }

      const extra =
        resolvedDate && events.length > 0
          ? `\n\n${label}:\n\n${scheduleLines}`
          : resolvedDate
          ? "\n\n해당 날짜에 등록된 일정이 없습니다."
          : "";

      const message = (result.message || "") + extra;

      return JSON.stringify({
        ok: result.ok,
        action: "update",
        ...result,
        events,
        message
      });
    }

    return JSON.stringify({
      ok: false,
      action,
      message: `알 수 없는 일정 action 입니다: ${action}`
    });
  }
});

export const noteTool = new DynamicStructuredTool({
  name: "note_add",
  description: "메모 추가",
  schema: z.object({
    text: z.string()
  }),
  func: async (input) => {
    return JSON.stringify({ saved: true, ...input });
  }
});

export const smartHomeTool = new DynamicStructuredTool({
  name: "smart_home",
  description: "스마트홈 제어",
  schema: z.object({
    device: z.string(),
    action: z.enum(["on", "off", "toggle"]).optional()
  }),
  func: async (input) => {
    const r = await sendToPhone("SMART_HOME", {
      device: input.device,
      action: input.action || "toggle"
    });
    return JSON.stringify(r);
  }
});

export const ttsTool = new DynamicStructuredTool({
  name: "tts_stream",
  description: "텍스트를 음성으로 변환하고 URL 또는 스트림 키 반환",
  schema: z.object({ text: z.string() }),
  func: async (input) => {
    const text = String(input.text || "").trim();
    if (!text) return JSON.stringify({ ok: false, error: "text required" });

    const provider = (process.env.TTS_PROVIDER || "minimax").toLowerCase();

    if (provider === "piper") {
      const enc = encodeURIComponent(text);
      return JSON.stringify({ ok: true, type: "url", url: `/api/tts/piper?text=${enc}` });
    }

    const norm = await hailuoTtsRequest(text, {
      model: "speech-02-turbo",
      stream: false,
      output_format: "url",
      voice_id: process.env.TTS_VOICE_ID || "audiobook_female_1",
      format: "mp3",
      sample_rate: 24000,
      bitrate: 128000,
      channel: 1
    });
    return JSON.stringify(norm);
  }
});

export const cameraCaptureTool = new DynamicStructuredTool({
  name: "camera_capture",
  description: "연결된 안드로이드 단말에 즉시 카메라 촬영을 요청한다.",
  schema: z.object({
    sessionId: z.string(),
    prompt: z.string().optional()
  }),
  func: async (input) => {
    const sessionId = String(input.sessionId || "");
    const prompt = String(input.prompt || "사진 촬영 후 자동으로 업로드해줘.");
    if (!sessionId) return JSON.stringify({ ok: false, error: "sessionId required" });

    wsSend(sessionId, { type: "tool", name: "camera.capture", prompt });
    return JSON.stringify({ ok: true, sent: true });
  }
});
