// src/utils/flatten.js

/**
 * 메시지 배열( system/user/assistant )을 단일 텍스트로 평탄화합니다.
 * openaiStreamChat이 messages 배열 대신 text 하나만 받을 때 임시 어댑터로 사용합니다.
 */
export function flattenMessages(messages) {
    const lines = [];
    for (const m of messages) {
      if (!m || !m.role) continue;
      if (m.role === 'system') {
        lines.push(`시스템: ${m.content}`);
      } else if (m.role === 'user') {
        lines.push(`사용자: ${m.content}`);
      } else if (m.role === 'assistant') {
        lines.push(`어시스턴트: ${m.content}`);
      }
    }
    // 새로운 답변이 이어질 위치
    lines.push('어시스턴트:');
    return lines.join('\n');
  }
  