// src/tools/jarvisTools.js
// 코드 주석에 이모티콘은 사용하지 마세요.
// @ts-check
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

// 실제 단말 제어는 ws.js의 브리지로 교체하면 된다.
async function sendToPhone(type, payload) {
  return { ok: true, type, payload };
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
    return JSON.stringify({ url: "jarvis-tts://stream/demo", input });
  },
});
