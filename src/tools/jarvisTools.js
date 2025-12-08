// src/tools/jarvisTools.js
// src/tools/jarvisTools.js
// 코드 주석에 이모티콘은 사용하지 마세요.
// @ts-check
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { wsSend } from "../ws.js";
import fetch from "node-fetch";

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
  const apiKey  = process.env.MINIMAX_API_KEY;

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
    subtitle_enable = false,
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

  // HTTP 에러면 그대로 반환
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    return { ok: false, error: `MiniMax TTS HTTP ${r.status} ${detail}` };
  }

  const json = await r.json().catch(() => ({}));

  // 1) 새 스키마: base_resp.status_code === 0 이고 data.audio 에 URL
  const statusCode = json?.base_resp?.status_code;
  const audioFromData = json?.data?.audio;  // 네가 방금 받은 응답 형태
  if (statusCode === 0 && typeof audioFromData === "string" && audioFromData.startsWith("http")) {
    return { ok: true, type: "url", url: audioFromData };
  }

  // 2) 구 스키마: audio_url / base64
  const audioUrl = json?.audio_url || json?.url;
  const base64   = json?.base64 || json?.audio;
  if (audioUrl) return { ok: true, type: "url", url: audioUrl };
  if (base64)   return { ok: true, type: "base64", base64, mime: "audio/mp3" };

  // 3) 실패 상세 전달
  const errMsg = json?.base_resp?.status_msg || "Unexpected MiniMax response";
  return { ok: false, error: errMsg, data: json };
}


export const openAppTool = new DynamicStructuredTool({
  name: "open_app",
  description: "모바일 앱 실행 또는 앱 내 검색",
  schema: z.object({
    app: z.string(),
    query: z.string().optional(),
  }),
  func: async (input) => {
    const r = await sendToPhone("OPEN_APP", input);
    return JSON.stringify(r);
  },
});

export const playMediaTool = new DynamicStructuredTool({
  name: "play_media",
  description: "음악/영상 재생",
  schema: z.object({
    provider: z.enum(["YouTube", "Melon", "Spotify"]).optional(),
    query: z.string(),
  }),
  func: async (input) => {
    const r = await sendToPhone("PLAY_MEDIA", {
      provider: input.provider || "YouTube",
      query: input.query,
    });
    return JSON.stringify(r);
  },
});

export const webSearchTool = new DynamicStructuredTool({
  name: "web_search",
  description: "간단한 웹검색",
  schema: z.object({
    q: z.string(),
  }),
  func: async (input) => {
    return JSON.stringify({
      results: [{ title: "검색 예시", url: "https://example.com?q=" + encodeURIComponent(input.q) }],
    });
  },
});

export const calendarTool = new DynamicStructuredTool({
  name: "calendar_add",
  description: "일정 추가",
  schema: z.object({
    title: z.string(),
    when: z.string(),
  }),
  func: async (input) => {
    return JSON.stringify({ created: true, id: "evt_demo", ...input });
  },
});

export const noteTool = new DynamicStructuredTool({
  name: "note_add",
  description: "메모 추가",
  schema: z.object({
    text: z.string(),
  }),
  func: async (input) => {
    return JSON.stringify({ saved: true, ...input });
  },
});

export const smartHomeTool = new DynamicStructuredTool({
  name: "smart_home",
  description: "스마트홈 제어",
  schema: z.object({
    device: z.string(),
    action: z.enum(["on", "off", "toggle"]).optional(),
  }),
  func: async (input) => {
    const r = await sendToPhone("SMART_HOME", {
      device: input.device,
      action: input.action || "toggle",
    });
    return JSON.stringify(r);
  },
});

export const ttsTool = new DynamicStructuredTool({
  name: "tts_stream",
  description: "텍스트를 음성으로 변환하고 URL 또는 스트림 키 반환",
  schema: z.object({ text: z.string() }),
  func: async (input) => {
    const text = String(input.text || "").trim();
    if (!text) return JSON.stringify({ ok: false, error: "text required" });

    const provider = (process.env.TTS_PROVIDER || "minimax").toLowerCase();

    // Piper 같은 로컬 폴백을 쓰는 경우
    if (provider === "piper") {
      const enc = encodeURIComponent(text);
      return JSON.stringify({ ok: true, type: "url", url: `/api/tts/piper?text=${enc}` });
    }

    // MiniMax 기본
    const norm = await hailuoTtsRequest(text, {
      model: "speech-02-turbo",
      stream: false,
      output_format: "url",
      voice_id: process.env.TTS_VOICE_ID || "audiobook_female_1",
      format: "mp3",
      sample_rate: 24000,
      bitrate: 128000,
      channel: 1,
    });
    return JSON.stringify(norm);
  },
});

// 세션의 단말에게 카메라 촬영을 요청한다.
// sessionId는 server에서 주입하여 도구 실행 시 payload로 넘어오도록 한다.
export const cameraCaptureTool = new DynamicStructuredTool({
  name: "camera_capture",
  description: "연결된 안드로이드 단말에 즉시 카메라 촬영을 요청한다.",
  schema: z.object({
    sessionId: z.string(),
    prompt: z.string().optional(),
  }),
  func: async (input) => {
    const sessionId = String(input.sessionId || "");
    const prompt = String(input.prompt || "사진 촬영 후 자동으로 업로드해줘.");
    if (!sessionId) return JSON.stringify({ ok: false, error: "sessionId required" });

    wsSend(sessionId, { type: "tool", name: "camera.capture", prompt });
    return JSON.stringify({ ok: true, sent: true });
  },
});
