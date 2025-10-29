// src/tools/meeting.js
const { llmComplete } = require('../llm/openaiCompat'); // 기존 단발 LLM 완성 함수 가정

function buildSummaryPrompt(logs=[]) {
  const text = logs.map(l => `${new Date(l.ts).toISOString()} [${l.role}] ${l.text}`).join('\n');
  return `다음 회의 기록을 한국어로 핵심 요약해줘. 액션아이템, 결정사항, 미해결 이슈를 목록화하고, 5줄 이내 TL;DR로 마무리해.\n\n${text}`;
}

async function summarizeMeetingLogs(logs) {
  const prompt = buildSummaryPrompt(logs || []);
  const out = await llmComplete({ system: '당신은 전문 비서입니다.', user: prompt });
  return out;
}

module.exports = { summarizeMeetingLogs };
