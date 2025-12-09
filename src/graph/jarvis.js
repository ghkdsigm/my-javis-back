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
  
    const txt = String(s.text || "");
    const hasCalendarKeyword = /(일정|스케줄|약속|예약)/.test(txt);
    const hasTimeKeyword =
      /(오늘|내일|모레|이번주|이번 주|다음주|다음 주|월요일|화요일|수요일|목요일|금요일|토요일|일요일|요일|시|분)/.test(
        txt
      );
  
    // NLU가 chat으로 줬어도, 일정 + 시간 키워드가 있으면 강제로 calendar_add로 보정
    if (
      s.cmd &&
      s.cmd.intent === "chat" &&
      hasCalendarKeyword &&
      hasTimeKeyword
    ) {
      s.cmd.intent = "calendar_add";
  
      if (!s.cmd.action) {
        if (/취소|삭제/.test(txt)) {
          s.cmd.action = "cancel";
        } else if (/바꿔|변경|수정/.test(txt)) {
          s.cmd.action = "update";
        } else if (/잡아줘|예약|등록|추가/.test(txt)) {
          s.cmd.action = "add";
        } else {
          s.cmd.action = "list";
        }
      }
  
      if (!s.cmd.when) {
        s.cmd.when = txt;
      }
    }
  
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
      await calendarTool.invoke({
        action: s.cmd.action || "add",
        title: s.cmd.title,
        when: s.cmd.when,
        date: s.cmd.date,
        time: s.cmd.time,
        id: s.cmd.id,
        newTitle: s.cmd.newTitle
      })
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
    let say = "";
  
    // 1순위: tool 결과에 message 필드가 있으면 그대로 사용
    if (s.result && typeof s.result.message === "string" && s.result.message.trim()) {
      say = s.result.message.trim();
    } else {
      // 2순위: intent 별 기본 멘트
      say =
        s.cmd?.intent === "open_app"
          ? "앱을 실행합니다."
          : s.cmd?.intent === "play_music"
          ? "재생을 시작합니다."
          : s.cmd?.intent === "web_search"
          ? "검색 결과를 표시했습니다."
          : s.cmd?.intent === "calendar_add"
          ? "일정을 처리했습니다."
          : s.cmd?.intent === "note_add"
          ? "메모를 저장했습니다."
          : s.cmd?.intent === "smart_home"
          ? "스마트홈 동작을 수행했습니다."
          : String(s.result?.text || "완료했습니다.");
    }
  
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
