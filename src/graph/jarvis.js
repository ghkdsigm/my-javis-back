// src/graph/jarvis.js
// @ts-check
import { StateGraph, END } from "@langchain/langgraph";
import { parseUtterance } from "../nlu/structured.js";
import {
  openAppTool,
  playMediaTool,
  webSearchTool,
  calendarTool,
  noteTool,
  smartHomeTool,
  ttsTool,
  cameraCaptureTool
} from "../tools/jarvisTools.js";

export function buildJarvisGraph() {
  const g = new StateGraph({ channels: ["text", "cmd", "result", "speech"] });

  // 시작점에서 classify로 진입시키는 스타트 엣지
  g.addEdge("__start__", "classify");

  g.addNode("classify", async (s) => {
    s.cmd = await parseUtterance(s.text || "");
    return s;
  });

  g.addConditionalEdges("classify", (s) => {
    switch (s.cmd?.intent) {
      case "open_app":
        return "do_open_app";
      case "play_music":
        return "do_play_music";
      case "web_search":
        return "do_web_search";
      case "calendar_add":
        return "do_calendar_add";
      case "note_add":
        return "do_note_add";
      case "smart_home":
        return "do_smart_home";
      case "travel_time": 
        return "do_naver_maps";
      case "take_photo":
        return "do_camera_capture";
      default:
        return "do_chat";
    }
  });

  g.addNode("do_open_app", async (s) => {
    s.result = JSON.parse(
      await openAppTool.invoke({ app: s.cmd.app, query: s.cmd.query })
    );
    return s;
  });

  g.addNode("do_play_music", async (s) => {
    s.result = JSON.parse(
      await playMediaTool.invoke({
        provider: s.cmd.provider || "YouTube",
        query: s.cmd.query || s.text,
      })
    );
    return s;
  });

  g.addNode("do_web_search", async (s) => {
    s.result = JSON.parse(
      await webSearchTool.invoke({ q: s.cmd.query || s.text })
    );
    return s;
  });

  g.addNode("do_calendar_add", async (s) => {
    s.result = JSON.parse(
      await calendarTool.invoke({ title: s.cmd.title, when: s.cmd.when })
    );
    return s;
  });

  g.addNode("do_note_add", async (s) => {
    s.result = JSON.parse(
      await noteTool.invoke({ text: s.cmd.text || s.text })
    );
    return s;
  });

  g.addNode("do_smart_home", async (s) => {
    s.result = JSON.parse(
      await smartHomeTool.invoke({
        device: s.cmd.device,
        action: s.cmd.action || "toggle",
      })
    );
    return s;
  });

  g.addNode("do_chat", async (s) => {
    s.result = { text: "처리했습니다." };
    return s;
  });

  g.addNode("speak", async (s) => {
    const say =
      s.cmd?.intent === "open_app"
        ? "앱을 실행합니다."
        : s.cmd?.intent === "play_music"
        ? "재생을 시작합니다."
        : s.cmd?.intent === "web_search"
        ? "검색 결과를 표시했습니다."
        : s.cmd?.intent === "calendar_add"
        ? "일정을 추가했습니다."
        : s.cmd?.intent === "note_add"
        ? "메모를 저장했습니다."
        : s.cmd?.intent === "smart_home"
        ? "스마트홈 동작을 수행했습니다."
        : String(s.result?.text || "완료했습니다.");

    s.speech = JSON.parse(await ttsTool.invoke({ text: say }));
    return s;
  });

  g.addNode("do_naver_maps", async (s) => {
    // s.cmd.start, s.cmd.end 같은 슬롯을 NLU에서 채워둔다고 가정
    // 앱 쪽에서 바로 열 수 있도록 이벤트로만 내려보낸다.
    const payload = { type: "naver_maps_route", start: s.cmd.start, end: s.cmd.end, mode: s.cmd.mode || "transit" };
    s.result = payload;
    return s;
  });

  g.addNode("do_camera_capture", async (s) => {
    // 도구 호출 시 sessionId를 함께 넘겨준다(서버에서 주입).
    s.result = JSON.parse(await cameraCaptureTool.invoke({
      sessionId: s.sessionId || 'android',
      prompt: s.text || ''
    }));
    s.speech = "촬영을 시작할게요.";
    return s;
  });

  g.addEdge("do_open_app", "speak");
  g.addEdge("do_play_music", "speak");
  g.addEdge("do_web_search", "speak");
  g.addEdge("do_calendar_add", "speak");
  g.addEdge("do_note_add", "speak");
  g.addEdge("do_smart_home", "speak");
  g.addEdge("do_chat", "speak");
  g.addEdge("do_naver_maps", "speak");
  g.addEdge("do_camera_capture", "speak");
  g.addEdge("speak", END);

  return g.compile();
}
