// src/tools/router.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import {
  parseWeatherIntent,
  getWeather,
  parsePrecipQuestion,
  getPrecipitationAnswer,
} from './openweather.js';

/**
 * 매우 단순한 룰 기반 툴 트리거.
 * send(eventName, payload) 콜백으로 외부에 알린다.
 * 
 * 처리했으면 true, 아니면 false를 반환한다.
 * 
 * @param {string} text
 * @param {(event: string, payload: any) => void} send
 * @returns {Promise<boolean>}
 */
export async function maybeEmitToolEvent(text, send) {
  const lower = String(text || '').toLowerCase();

  // 1) 강수(비/눈) 질의는 최우선
  const pq = parsePrecipQuestion(text);
  if (pq) {
    try {
      const ans = await getPrecipitationAnswer(pq);
      send('tool', { ok: true, type: 'weather.precip', ...ans });
      // 요약 텍스트도 함께 내려 클라가 바로 표시/읽기 가능
      send('tool', { ok: true, type: 'weather', text: ans.text });
      return true; // 여기서 끝
    } catch (e) {
      send('tool', { ok: false, type: 'weather.precip', error: e?.message || '강수 조회 실패' });
      return true; // 에러라도 LLM로 넘기지 않음(중복 방지)
    }
  }

  // 2) 일반 날씨(오늘/내일/이번주/다음주)
  if (/(날씨|weather)/.test(lower)) {
    try {
      const intent = parseWeatherIntent(text);
      const w = await getWeather(intent);
      const payload = {
        ok: true,
        type: 'weather',
        when: intent.when,
        city: w.location,
        ...(w.daily ? { daily: w.daily } : { now: w.now }),
        text: w.text,
        ...(w.limited ? { limited: true } : {}),
      };
      send('tool', payload);
      return true; // 여기서 끝
    } catch (e) {
      send('tool', { ok: false, type: 'weather', error: e?.message || 'OpenWeather 호출 실패' });
      return true; // 에러라도 LLM로 넘기지 않음(중복 방지)
    }
  }

  // 3) 알림/예약 테스트
  if (lower.includes('알림')) {
    send('tool', { ok: true, type: 'notification', message: '테스트 알림 예약 완료' });
    return true;
  }
  if (lower.includes('예약')) {
    send('tool', { ok: true, type: 'schedule', summary: '테스트 일정 생성', when: new Date(Date.now() + 3600_000).toISOString() });
    return true;
  }

  // 어떤 룰에도 걸리지 않음 → LLM에게 넘김
  return false;
}
