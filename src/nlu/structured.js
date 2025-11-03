// src/nlu/structured.js
// @ts-check
import { z } from "zod";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { ChatOllama } from "@langchain/ollama";

const CommandSchema = z.object({
  intent: z.enum([
    "chat",
    "open_app",
    "play_music",
    "web_search",
    "calendar_add",
    "note_add",
    "smart_home"
  ]).default("chat"),
  app: z.string().optional(),
  provider: z.string().optional(),
  query: z.string().optional(),
  title: z.string().optional(),
  when: z.string().optional(),
  text: z.string().optional(),
  device: z.string().optional(),
  action: z.string().optional(),
  utterance: z.string().optional()
});

const parser = StructuredOutputParser.fromZodSchema(CommandSchema);

export async function parseUtterance(utterance) {
  const llm = new ChatOllama({
    baseUrl: process.env.LLM_BASE_URL || process.env.GEMMA_BASE_URL || "http://127.0.0.1:11434",
    model: process.env.GEMMA_MODEL || "exaone3.5:7.8b",
    temperature: 0.1
  });

  const prompt = [
    { role: "system", content: "사용자 음성 명령을 JSON으로만 구조화하라." },
    { role: "user", content: String(utterance || "") },
    { role: "assistant", content: parser.getFormatInstructions() }
  ];

  const res = await llm.invoke(prompt);
  return parser.parse(String(res.content || ""));
}
