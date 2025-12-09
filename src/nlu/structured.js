// src/nlu/structured.js
// @ts-check
import { z } from "zod";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { ChatOllama } from "@langchain/ollama";

const CommandSchema = z.object({
  intent: z
    .enum([
      "chat",
      "open_app",
      "play_music",
      "web_search",
      "calendar_add",
      "note_add",
      "smart_home"
    ])
    .default("chat"),

  app: z.string().optional(),
  provider: z.string().optional(),
  query: z.string().optional(),

  // 일정 관련 필드
  title: z.string().optional(),    // 일정 제목
  when: z.string().optional(),     // 사용자가 말한 시간 표현 그대로 ("오늘 저녁 8시" 등)
  date: z.string().optional(),     // YYYY-MM-DD 형식
  time: z.string().optional(),     // HH:mm 형식
  id: z.string().optional(),       // 특정 일정 id가 있을 경우
  newTitle: z.string().optional(), // 수정용 새 제목

  // 메모, 스마트홈 등
  text: z.string().optional(),
  device: z.string().optional(),

  // calendar_add에서 사용:
  // - "add"   : 일정 추가
  // - "list"  : 일정 조회 (오늘/이번주/이번달)
  // - "cancel": 일정 취소
  // - "update": 일정 제목 수정
  action: z.string().optional(),

  // 원 발화 전체
  utterance: z.string().optional()
});

const parser = StructuredOutputParser.fromZodSchema(CommandSchema);

export async function parseUtterance(utterance) {
  const llm = new ChatOllama({
    baseUrl:
      process.env.LLM_BASE_URL ||
      process.env.GEMMA_BASE_URL ||
      "http://127.0.0.1:11434",
    model: process.env.GEMMA_MODEL || "exaone3.5:7.8b",
    temperature: 0.1
  });

  const prompt = [
    {
      role: "system",
      content: [
        "당신은 안드로이드 음성 비서 자비스의 NLU 엔진이다.",
        "사용자 발화를 JSON 한 개로만 구조화해야 한다.",
        "",
        "반드시 JSON만 출력하고, 설명 문장은 절대 출력하지 않는다.",
        "",
        "필드 규칙:",
        "- intent: open_app, play_music, web_search, calendar_add, note_add, smart_home, chat 중 하나.",
        "- utterance: 사용자의 원문 전체.",
        "",
        "매우 중요:",
        "다음과 같은 단어가 포함되면 기본적으로 intent='calendar_add'를 사용해야 한다.",
        "- '일정', '스케줄', '약속', '예약'",
        "또한 날짜/시간/요일 표현(오늘, 내일, 모레, 이번주, 다음주, 월요일, 화요일, 오후 2시 등)이 같이 있으면",
        "반드시 intent='calendar_add' 로 설정한다. 이런 발화를 intent='chat' 으로 분류하지 않는다.",
        "",
        "calendar_add 의 경우:",
        "- action 필수: add / list / cancel / update 중 하나.",
        "  - 일정을 새로 만들면 action='add'",
        "  - '오늘 일정 뭐야', '이번주 일정 보여줘' 등 조회는 action='list'",
        "  - '오늘 8시 약속 취소해줘' 등은 action='cancel'",
        "  - '그 약속을 가족 모임으로 바꿔줘' 등은 action='update'",
        "- title: 일정 제목 (예: '대학교 모임', '가족 모임')",
        "- when: 사용자가 말한 시간 표현 그대로.",
        "- date: 가능한 경우 YYYY-MM-DD 형식으로 날짜만.",
        "- time: 가능한 경우 HH:mm 형식으로 24시 기준.",
        "- id: 사용자가 특정 일정 id를 말한 경우만.",
        "",
        "사용자의 의도를 설명하지 말고, 위 스키마에 맞는 JSON만 생성한다."
      ].join("\n")
    },
    { role: "user", content: String(utterance || "") },
    { role: "assistant", content: parser.getFormatInstructions() }
  ];

  const res = await llm.invoke(prompt);
  /** @type {any} */
  let cmd = await parser.parse(String(res.content || ""));

  // 여기부터 JS 레벨에서 한 번 더 보정
  const txt = String(utterance || "");
  const hasCalendarKeyword = /(일정|스케줄|약속|예약)/.test(txt);
  const hasTimeKeyword =
    /(오늘|내일|모레|이번주|이번 주|다음주|다음 주|월요일|화요일|수요일|목요일|금요일|토요일|일요일|요일|시|분)/.test(
      txt
    );

  if (hasCalendarKeyword && hasTimeKeyword) {
    // LLM이 chat으로 줬어도 강제로 calendar_add로 보정
    if (!cmd.intent || cmd.intent === "chat") {
      cmd.intent = "calendar_add";
    }

    // action이 비어 있거나 이상하면 기본은 조회(list)
    if (!cmd.action) {
      if (/취소|삭제/.test(txt)) {
        cmd.action = "cancel";
      } else if (/바꿔|변경|수정/.test(txt)) {
        cmd.action = "update";
      } else if (/잡아줘|예약|등록|추가/.test(txt)) {
        cmd.action = "add";
      } else {
        cmd.action = "list";
      }
    }

    // when이 비어있으면 원문을 그대로 when에 넣어준다
    if (!cmd.when) {
      cmd.when = txt;
    }

    // utterance도 항상 원문으로 세팅
    cmd.utterance = txt;
  }

  return cmd;
}

