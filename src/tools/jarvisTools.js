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
import { searchProfile } from "../profile/profileRagStore.js";

/**
 * 발화 텍스트에서 "오전/오후 N시 M분" 패턴을 파싱해 HH:mm으로 변환
 * explicitTime(LLM이 준 time)이 있으면 그걸 우선 사용한다.
 * @param {string | undefined} when
 * @param {string | undefined} explicitTime
 * @returns {string}
 */
function resolveTimeFromWhen(when, explicitTime) {
  const norm = explicitTime && explicitTime.trim();
  if (norm && /^\d{1,2}:\d{2}$/.test(norm)) {
    return norm;
  }

  if (!when) return norm || "";

  const text = String(when);
  // "오후 9시", "오전 10시 30분" 같은 형태만 처리
  const m = text.match(/(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (!m) return norm || "";

  const ampm = m[1];
  let h = parseInt(m[2], 10);
  const mm = m[3] ? parseInt(m[3], 10) : 0;

  if (ampm === "오후" && h < 12) h += 12;
  if (ampm === "오전" && h === 12) h = 0;

  const hhStr = String(h).padStart(2, "0");
  const mmStr = String(mm).padStart(2, "0");
  return `${hhStr}:${mmStr}`;
}

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
 * 일정/예약 발화에서 제목으로 쓰기 좋은 문자열로 정리
 * - 날짜/시간/조사/불필요한 동사 제거
 * @param {string | undefined} raw
 * @returns {string}
 */
function normalizeTitle(raw) {
  if (!raw) return "";
  let t = String(raw);

  // 1) 존칭/호칭/감탄 제거
  t = t.replace(/마스터[,\s]?/g, "");
  t = t.replace(/아니[,\s]?/g, "");

  // 2) 날짜 관련 표현 제거
  t = t.replace(/오늘|내일|모레|이번\s*주|이번주|다음\s*주|다음주|이번\s*달|이번달/g, "");
  t = t.replace(/(일|월|화|수|목|금|토)요일?/g, "");

  // 3) 오전/오후 + 시/분 표현 제거
  t = t.replace(/오전|오후/g, "");
  t = t.replace(/\d{1,2}\s*시(\s*\d{1,2}\s*분)?/g, "");

  // 4) 일정/제목 관련 단어 제거
  t = t.replace(/제목/g, "");
  t = t.replace(/일정|스케줄|약속|예약/g, "");

  // 5) 동사/요청 표현 제거
  t = t.replace(/잡아줘|잡아 줄/g, "");
  t = t.replace(/예약해줘|예약 해줘|예약해 줘/g, "");
  t = t.replace(/등록해줘|등록 해줘/g, "");
  t = t.replace(/추가해줘|추가 해줘/g, "");
  t = t.replace(/변경해줘|변경 해줘|변경해 줘|변경해|변경/g, "");
  t = t.replace(/바꿔줘|바꿔 줘|바꿔/g, "");
  t = t.replace(/수정해줘|수정 해줘|수정해 줘|수정/g, "");
  t = t.replace(/지워줘|지워 줘|삭제해줘|삭제 해줘|삭제해 줘|삭제/g, "");
  t = t.replace(/해달라고|해달라구|해달라/g, "");
  t = t.replace(/해줘|해 줘/g, "");

  // 6) 흔히 남는 조사/부사 정리
  t = t.replace(/^\s*에\s+/g, ""); // 문장 맨 앞의 "에 "
  t = t.replace(/으로\s*/g, " "); // "으로"는 의미를 크게 안 주는 경우가 많음
  t = t.replace(/\s*좀만?$/g, ""); // "좀", "좀만" 끝에 오는 것
  t = t.replace(/\s*요$/g, "");

  // 7) 문장부호 및 공백 정리
  t = t.replace(/[.,!?]/g, "");
  t = t.replace(/\s+/g, " ");
  t = t.trim();

  return t;
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
    chunks.push("");
  }

  return chunks.join("\n").trimEnd();
}

// 실제 단말 제어는 ws.js의 브리지로 교체하면 된다.
async function sendToPhone(type, payload) {
  return { ok: true, type, payload };
}

/**
 * Hailuo(MiniMax) TTS v2 호출
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
  description:
    "개인 일정 관리 도구. 일정 추가, 조회, 취소, 수정 기능을 수행한다.\n" +
    "- action='add': '예약해줘', '잡아줘', '일정 추가해줘' 등 일정 생성\n" +
    "- action='list': '일정 알려줘', '일정 보여줘', '이번주 일정' 등 조회\n" +
    "- action='cancel': '일정 취소해줘', '지워줘', '삭제해줘' 등 일정 삭제\n" +
    "- action='update': '일정 제목 바꿔줘', '약속 이름 변경해줘' 등 제목 수정",
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
      let title = normalizeTitle(input.title || "");

      if (!title && input.when) {
        title = normalizeTitle(input.when);
      }

      if (!title) {
        title = "제목 없음";
      }

      const resolvedTime = resolveTimeFromWhen(input.when || "", input.time);

      const ev = addEvent({
        title,
        date: resolvedDate || undefined,
        time: resolvedTime || undefined,
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

      const whenLabel = input.when || (ev.date + (ev.time ? " " + ev.time : ""));
      const messagePrefix =
        `네, 마스터. ${whenLabel}` + `에 "${ev.title}" 일정을 추가했습니다.`;
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
      const whenText = String(input.when || "");

      // "일정 전부 지워줘", "이번주 일정 전부 취소해줘" 같은 문장을
      // LLM이 list로 보내더라도 여기서 강제로 삭제로 처리
      const hasErase = /(지워줘|지워 줘|지워|삭제해줘|삭제 해줘|삭제해 줘|삭제|취소해줘|취소 해줘|취소해 줘|취소)/.test(
        whenText
      );
      const isAll = /(전부|모두|다|전체)/.test(whenText);
      const isWeek = /이번\s*주/.test(whenText);
      const isMonth = /이번\s*(달|월)/.test(whenText);

      if (hasErase && isAll) {
        // 여기서는 "전부 지워줘" 의 날짜/범위를 해석해서 실제로 다 지운다.

        const baseDate =
          resolveDateFromWhen(whenText, input.date, {
            fallbackToToday: true
          }) || toYMD(new Date());

        // 2-0-1) "이번주/이번달 일정 전부 지워줘" → 주/월 범위 전체 삭제
        if (isWeek || isMonth) {
          /** @type {"week"|"month"} */
          const range = isWeek ? "week" : "month";
          const targetEvents = listEvents({
            date: baseDate,
            range
          });

          const rangeLabel = isWeek ? "이번 주" : "이번 달";

          if (!targetEvents.length) {
            return JSON.stringify({
              ok: false,
              action: "cancel",
              message: `${rangeLabel}에 취소할 일정이 없습니다.`
            });
          }

          for (const ev of targetEvents) {
            cancelEvent({ id: ev.id });
          }

          const afterEvents = listEvents({
            date: baseDate,
            range
          });

          const message =
            `네, 마스터. ${rangeLabel}에 등록된 일정 ${targetEvents.length}건을 모두 취소했습니다.` +
            (afterEvents.length
              ? `\n\n취소 후 남은 일정:\n\n${buildWeekOrMonthScheduleLines(afterEvents)}`
              : `\n\n지금은 ${rangeLabel}에 등록된 일정이 없습니다.`);

          return JSON.stringify({
            ok: true,
            action: "cancel",
            canceledCount: targetEvents.length,
            events: afterEvents,
            message
          });
        }

        // 2-0-2) "일정 전부 지워줘" 처럼 날짜만(또는 오늘)인 경우 → 하루치 전부 삭제
        const targetEvents = listEvents({
          date: baseDate,
          range: "day"
        });

        if (!targetEvents.length) {
          const msg =
            whenText.includes("오늘") || !whenText
              ? "오늘 취소할 일정이 없습니다."
              : `${baseDate}에 취소할 일정이 없습니다.`;
          return JSON.stringify({
            ok: false,
            action: "cancel",
            message: msg
          });
        }

        for (const ev of targetEvents) {
          cancelEvent({ id: ev.id });
        }

        const afterEvents = listEvents({
          date: baseDate,
          range: "day"
        });

        const label =
          whenText.includes("오늘") || !whenText
            ? "오늘"
            : baseDate;

        const message =
          `네, 마스터. ${label}에 등록된 일정 ${targetEvents.length}건을 모두 취소했습니다.` +
          (afterEvents.length
            ? `\n\n취소 후 남은 일정:\n\n${buildDayScheduleLines(afterEvents)}`
            : `\n\n지금은 ${label}에 등록된 일정이 없습니다.`);

        return JSON.stringify({
          ok: true,
          action: "cancel",
          canceledCount: targetEvents.length,
          events: afterEvents,
          message
        });
      }

      // 여기서부터는 진짜 "조회"인 경우만 처리
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
      const whenText = String(input.when || "");

      const isAll = /(전부|모두|다|전체)/.test(whenText);
      const isWeek = /이번\s*주/.test(whenText);
      const isMonth = /이번\s*(달|월)/.test(whenText);

      // 3-0) "이번주 약속 전부 취소해줘", "이번달 일정 다 취소해줘" 같은 패턴 처리
      if (isAll && (isWeek || isMonth)) {
        const baseDate =
          resolveDateFromWhen(input.when || "", input.date, {
            fallbackToToday: true
          }) || toYMD(new Date());

        /** @type {"week"|"month"} */
        const range = isWeek ? "week" : "month";
        const targetEvents = listEvents({
          date: baseDate,
          range
        });

        const rangeLabel = isWeek ? "이번 주" : "이번 달";

        if (!targetEvents.length) {
          return JSON.stringify({
            ok: false,
            action: "cancel",
            message: `${rangeLabel}에 취소할 일정이 없습니다.`
          });
        }

        for (const ev of targetEvents) {
          cancelEvent({ id: ev.id });
        }

        const afterEvents = listEvents({
          date: baseDate,
          range
        });

        const message =
          `네, 마스터. ${rangeLabel}에 등록된 일정 ${targetEvents.length}건을 모두 취소했습니다.` +
          (afterEvents.length
            ? `\n\n취소 후 남은 일정:\n\n${buildWeekOrMonthScheduleLines(afterEvents)}`
            : `\n\n지금은 ${rangeLabel}에 등록된 일정이 없습니다.`);

        return JSON.stringify({
          ok: true,
          action: "cancel",
          canceledCount: targetEvents.length,
          events: afterEvents,
          message
        });
      }

      // 3-0-bis) "일정 전부 지워줘" 처럼 날짜 없이 전부 지우라는 말만 있는 경우
      if (isAll && !isWeek && !isMonth) {
        const baseDate =
          resolveDateFromWhen(input.when || "", input.date, {
            fallbackToToday: true
          }) || toYMD(new Date());

        const targetEvents = listEvents({
          date: baseDate,
          range: "day"
        });

        if (!targetEvents.length) {
          const msg =
            input.when && input.when.includes("오늘")
              ? "오늘 취소할 일정이 없습니다."
              : `${baseDate}에 취소할 일정이 없습니다.`;
          return JSON.stringify({
            ok: false,
            action: "cancel",
            message: msg
          });
        }

        for (const ev of targetEvents) {
          cancelEvent({ id: ev.id });
        }

        const afterEvents = listEvents({
          date: baseDate,
          range: "day"
        });

        const label =
          input.when && input.when.includes("오늘")
            ? "오늘"
            : baseDate;

        const message =
          `네, 마스터. ${label}에 등록된 일정 ${targetEvents.length}건을 모두 취소했습니다.` +
          (afterEvents.length
            ? `\n\n취소 후 남은 일정:\n\n${buildDayScheduleLines(afterEvents)}`
            : `\n\n지금은 ${label}에 등록된 일정이 없습니다.`);

        return JSON.stringify({
          ok: true,
          action: "cancel",
          canceledCount: targetEvents.length,
          events: afterEvents,
          message
        });
      }

      // 3-1) 기존: 특정 날짜/시간 또는 id 기반 취소
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

      const resolvedTime = resolveTimeFromWhen(input.when || "", input.time);

      const result = cancelEvent({
        id: input.id,
        date: resolvedDate || undefined,
        time: resolvedTime || undefined
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
      const whenText = String(input.when || "");

      // 1) 날짜 해석
      const resolvedDate = resolveDateFromWhen(whenText, input.date, {
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

      // 2) 시간 해석 (툴이 time을 안 넘겨줘도 when에서 뽑아서 사용)
      const resolvedTime = resolveTimeFromWhen(whenText, input.time);

      // 3) 새 제목 해석
      let newTitle = (input.newTitle || input.title || "").trim();

      if (!newTitle && whenText) {
        let t = whenText;

        // 존칭/호칭 제거
        t = t.replace(/마스터[,\s]?/g, "");

        // 날짜 표현 제거
        t = t.replace(/오늘|내일|모레|이번\s*주|이번주|다음\s*주|다음주|이번\s*달|이번달/g, "");
        t = t.replace(/(일|월|화|수|목|금|토)요일?/g, "");

        // 오전/오후 + 시/분 제거
        t = t.replace(/오전|오후/g, "");
        t = t.replace(/\d{1,2}\s*시(\s*\d{1,2}\s*분)?/g, "");

        // '약속/일정/제목/예약' 같은 단어 제거
        t = t.replace(/일정|스케줄|약속|예약|제목/g, "");

        // '으로/로 변경/바꿔줘/바꿔 줘' 등의 패턴 제거
        t = t.replace(/으로|로/g, "");
        t = t.replace(/변경해줘|변경 해줘|변경해 줘|변경해|변경/g, "");
        t = t.replace(/바꿔줘|바꿔 줘|바꿔줘요|바꿔/g, "");

        // 기타 '해줘/해 줘' 제거
        t = t.replace(/해줘|해 줘/g, "");

        // 문장부호/여분 공백 정리
        t = t.replace(/[.,!?]/g, "");
        t = t.replace(/\s+/g, " ");
        t = t.trim();

        if (t) {
          newTitle = t;
        }
      }

      if (!newTitle) {
        return JSON.stringify({
          ok: false,
          action: "update",
          message:
            "변경할 제목이 비어 있습니다. '오늘 8시 약속을 회사 티타임으로 바꿔줘'처럼 새 제목을 포함해서 말해 주세요."
        });
      }

      const result = updateEventTitle({
        id: input.id,
        date: resolvedDate || undefined,
        time: resolvedTime || undefined,
        newTitle
      });

      const events = resolvedDate ? listEvents({ date: resolvedDate, range: "day" }) : [];
      const scheduleLines = resolvedDate ? buildDayScheduleLines(events) : "";

      let label;
      if (whenText.includes("오늘")) {
        label = "오늘의 일정은 다음과 같습니다";
      } else if (whenText.includes("내일")) {
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

export const userProfileTool = new DynamicStructuredTool({
  name: "user_profile_search",
  description:
    "사용자의 장점, 약점, 취향, 좋아하는 음식/음악/활동 등의 개인 프로필 정보를 RAG로 조회한다. " +
    "기분, 날씨, 상황에 맞춰 추천을 만들 때 사용하라.",
  schema: z.object({
    query: z.string().describe("알고 싶은 내용이나 상황 설명. 예: '비 오는 날 듣기 좋은 노래', '집중해서 코딩할 때 음악 추천'")
  }),
  func: async (input) => {
    const results = await searchProfile(input.query);
    return JSON.stringify({ results });
  }
});