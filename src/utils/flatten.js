// src/utils/flatten.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

/**
 * 메시지 배열( system/user/assistant )을 단일 텍스트로 평탄화합니다.
 * 각 메시지는 최대 maxChars로 절단하여 과도한 컨텍스트를 방지합니다.
 */
export function flattenMessages(messages, maxChars = 12000) {
    const lines = [];
    for (const m of messages) {
      if (!m || !m.role) continue;
      const content = String(m.content || '');
      const clipped = content.length > maxChars ? content.slice(0, maxChars) + ' ...' : content;
      if (m.role === 'system') {
        lines.push(`시스템: ${clipped}`);
      } else if (m.role === 'user') {
        lines.push(`사용자: ${clipped}`);
      } else if (m.role === 'assistant') {
        lines.push(`어시스턴트: ${clipped}`);
      }
    }
    lines.push('어시스턴트:');
    return lines.join('\n');
  }
  