// 코드 주석에 이모티콘은 사용하지 않습니다.
/**
 * 매우 단순한 룰 기반 툴 트리거 예시.
 * 실제로는 캘린더/알림/스마트홈/웹훅 등을 호출한 뒤 결과를 'tool' 이벤트로 내보내면 된다.
 */
export function maybeEmitToolEvent(text, res) {
  const lower = text.toLowerCase();
  if (lower.includes('알림')) {
    const payload = { type: 'notification', message: '테스트 알림 예약 완료' };
    res.write(`event: tool\n`);
    res.write(`data: ${JSON.stringify({ ok: true, ...payload })}\n\n`);
  } else if (lower.includes('예약')) {
    const payload = { type: 'schedule', summary: '테스트 일정 생성', when: new Date(Date.now() + 3600_000).toISOString() };
    res.write(`event: tool\n`);
    res.write(`data: ${JSON.stringify({ ok: true, ...payload })}\n\n`);
  }
}
