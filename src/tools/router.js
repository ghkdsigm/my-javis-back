// src/tools/router.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import {
  parseWeatherIntent,
  getWeather,
  parsePrecipQuestion,
  getPrecipitationAnswer,
} from './openweather.js';

import {
  searchNews,
  pickByKeyword,
  summarizeArticle,
} from './naverNews.js';

import { embedOneCached, cosine } from '../utils/embeddings.js';

// ---------------------- 임베딩 기반 의도 인식 ----------------------

const INTENT_SEEDS = {
  'weather.ask': ['날씨 어때', '기온 알려줘', '비 오냐', '우산 챙겨?', 'weather'],
  'news.list':   ['뉴스 알려줘', '기사 찾아줘', '최신 소식', 'news'],
};

// 추가 가드: 의도별 최소 키워드(임베딩 매칭 + 힌트 동시 충족 시에만 발동)
const INTENT_HINTS = {
  'weather.ask': ['날씨','기온','온도','비','눈','강수','우산','weather','예보','미세먼지'],
  'news.list':   ['뉴스','기사','소식','news','요약','검색','리스트','목록','추천'],
};

const INTENT_THRESHOLD = Number(process.env.INTENT_THRESHOLD || 0.65);

// 시드 문장 임베딩 미리 계산
const intentVecs = {};
for (const [key, arr] of Object.entries(INTENT_SEEDS)) {
  intentVecs[key] = await Promise.all(arr.map(s => embedOneCached(s)));
}

async function guessIntent(text) {
  const qv = await embedOneCached(text);
  let bestKey = null, best = -1;
  for (const [key, vecs] of Object.entries(intentVecs)) {
    for (const v of vecs) {
      const sc = cosine(qv, v);
      if (sc > best) { best = sc; bestKey = key; }
    }
  }
  return { key: bestKey, score: best };
}

// ---------------------- 뉴스/날씨 캐시 및 유틸 ----------------------

let lastNewsList = [];
let lastNewsQuery = '';
let lastNewsAt = 0;
const NEWS_TTL_MS = 5 * 60 * 1000;

let lastPicked = null;

// 입력 디바운스: 같은 입력을 짧은 시간 내 여러 번 받으면 무시
let lastInputKey = '';
let lastInputAt = 0;
function shouldSkipSameInput(text, ms = 1200) {
  const key = String(text || '').trim();
  const now = Date.now();
  if (key && key === lastInputKey && now - lastInputAt < ms) return true;
  lastInputKey = key;
  lastInputAt = now;
  return false;
}

// 출력 디바운스: 같은 채널+문구를 짧은 간격에 재전송하지 않음
let lastEmitKey = '';
let lastEmitAt = 0;
function emitOnce(send, channel, payload) {
  const key = channel + '|' + (payload?.text || payload?.error || '');
  const now = Date.now();
  if (key && key === lastEmitKey && now - lastEmitAt < 1500) return;
  lastEmitKey = key;
  lastEmitAt = now;
  send(channel, payload);
}

// 의도 디바운스: 동일 의도를 ms 내에 반복 실행하지 않음
const intentStamp = new Map();
function shouldDebounce(intentKey, ms) {
  const now = Date.now();
  const prev = intentStamp.get(intentKey) || 0;
  if (now - prev < ms) return true;
  intentStamp.set(intentKey, now);
  return false;
}

// 우리 시스템이 만든 뉴스/날씨 텍스트를 식별해 재트리거 차단
function isOurNewsListText(t) {
  const s = String(t || '');
  return /\d+월\s*\d+일\s*(일|월|화|수|목|금|토)요일\s*기준\s*상위\s*\d+건입니다/.test(s) && /특정 기사를 들으시려면/.test(s);
}
function isOurWeatherSummaryText(t) {
  const s = String(t || '');
  return /오늘\s*\d{1,2}월\s*\d{1,2}일.*서울\s*현재/.test(s) && /(도|℃).*(습도).*(바람)/.test(s);
}

// 보조 정규식 헬퍼
function hasAny(re, s) { return re.test(s); }

/**
 * 매우 단순한 룰 + 임베딩 기반 툴 트리거.
 * send(eventName, payload) 콜백으로 외부에 알린다.
 * 처리했으면 true, 아니면 false를 반환한다.
 *
 * ⚠️ 웨이크워드/세션 관리는 server.js의 /api/chat에서 수행하고,
 * 여기에는 "실제 사용자 의도 텍스트(웨이크워드 제거됨)"가 들어온다고 가정한다.
 */
export async function maybeEmitToolEvent(text, send) {
  const lower = String(text || '').toLowerCase();

  // 입력 디바운스
  if (shouldSkipSameInput(text)) return true;

  // 피드백 루프 차단
  if (isOurNewsListText(text) || isOurWeatherSummaryText(text)) return true;

  // router는 "요청 받음" 이벤트만 내보내고 true 반환하여 LLM/다른 툴로 안 흘러가게 한다.
  if (/(회의).*(요약|정리|메일|보내|전송)/i.test(text)) {
    send('meeting', { type: 'meeting.summary.request', text: '회의 요약을 준비할게요.' });
    return true;
  }

  // ---------------------- (A) 임베딩 기반 빠른 분기 ----------------------
  try {
    const { key, score } = await guessIntent(text);

    const hitHint = (intentKey) => {
      const hints = INTENT_HINTS[intentKey] || [];
      const l = lower;
      return hints.some(h => l.includes(h));
    };

    if (key && score >= INTENT_THRESHOLD) {
      if (key === 'weather.ask' && hitHint('weather.ask')) {
        if (shouldDebounce('weather', 1500)) return true;
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
          emitOnce(send, 'tool', payload);
          return true;
        } catch (e) {
          const msg = e?.message || 'OpenWeather 호출 실패';
          emitOnce(send, 'tool', { ok: false, type: 'weather', error: msg });
          return true;
        }
      }
      if (key === 'news.list' && hitHint('news.list')) {
        if (shouldDebounce('news.list', 1500)) return true;
        try {
          const q = extractNewsQuery(text);
          const items = await searchNews(q);

          const maxShow = Number(process.env.NAVER_NEWS_DISPLAY || 10);
          lastNewsList = (items || []).slice(0, maxShow);
          lastNewsQuery = q;
          lastNewsAt = Date.now();
          lastPicked = null;

          if (!lastNewsList.length) {
            emitOnce(send, 'tool', { ok: true, type: 'news.list', text: '관련 기사를 찾지 못했습니다.' });
            return true;
          }

          const speak = formatNewsList(lastNewsList);
          emitOnce(send, 'tool', {
            ok: true,
            type: 'news.list',
            text: speak,
            list: lastNewsList,
            query: q,
          });
          return true;
        } catch (e) {
          const msg = e?.message || '뉴스 조회 실패';
          emitOnce(send, 'tool', { ok: false, type: 'news.error', error: msg });
          return true;
        }
      }
    }
  } catch {
    // 임베딩 서버 오류 시에는 조용히 룰 기반으로 폴백
  }

  // ---------------------- (B) 룰 기반 분기 ----------------------

  // 1) 강수(비/눈) 우선
  const pq = parsePrecipQuestion(text);
  if (pq) {
    try {
      const ans = await getPrecipitationAnswer(pq);
      emitOnce(send, 'tool', { ok: true, type: 'weather.precip', ...ans });
      return true;
    } catch (e) {
      const msg = e?.message || '강수 조회 실패';
      emitOnce(send, 'tool', { ok: false, type: 'weather.precip', error: msg });
      return true;
    }
  }

  // 2) 일반 날씨: 키워드 + 동사 필요, 배제 표현이 있으면 막기
  const weatherKeyword = /(날씨|weather)/;
  const weatherAction  = /(말해줘|알려줘|예보|기온|온도|비|눈|강수|우산|어때|어떤지|상황|조회|확인)/;
  const exceptWords    = /(말고|빼고|제외|아니고|제쳐|치고)/;

  if (hasAny(weatherKeyword, lower) && hasAny(weatherAction, lower) && !hasAny(exceptWords, lower)) {
    if (shouldDebounce('weather', 1500)) return true;
    try {
      const intent = parseWeatherIntent(text);
      const w = await getWeather(intent);
      const payload = {
        ok: true,
        type: 'weather',
        when: intent.when,
        city: w.location,
        ...(w.daily ? { daily: w.daily } : { now: w.now } ),
        text: w.text,
        ...(w.limited ? { limited: true } : {}),
      };
      emitOnce(send, 'tool', payload);
      return true;
    } catch (e) {
      const msg = e?.message || 'OpenWeather 호출 실패';
      emitOnce(send, 'tool', { ok: false, type: 'weather', error: msg });
      return true;
    }
  }

  // 3) 뉴스 목록: 키워드 + 동사 필요, 배제 표현이 있으면 막기
  const newsKeyword = /(뉴스|기사|기사거리|소식|뉴스거리)/;
  const newsAction  = /(말해줘|알려줘|읽어줘|읽어봐|보여줘|찾아줘|검색|요약|리스트|목록|뭐있|무엇|추천)/;

  if (hasAny(newsKeyword, lower) && hasAny(newsAction, lower) && !hasAny(exceptWords, lower)) {
    if (shouldDebounce('news.list', 1500)) return true;

    try {
      const q = extractNewsQuery(text);
      const items = await searchNews(q);

      const maxShow = Number(process.env.NAVER_NEWS_DISPLAY || 10);
      lastNewsList = (items || []).slice(0, maxShow);
      lastNewsQuery = q;
      lastNewsAt = Date.now();
      lastPicked = null;

      if (!lastNewsList.length) {
        emitOnce(send, 'tool', { ok: true, type: 'news.list', text: '관련 기사를 찾지 못했습니다.' });
        return true;
      }

      const speak = formatNewsList(lastNewsList);
      emitOnce(send, 'tool', {
        ok: true,
        type: 'news.list',
        text: speak,
        list: lastNewsList,
        query: q,
      });
      return true;
    } catch (e) {
      const msg = e?.message || '뉴스 조회 실패';
      emitOnce(send, 'tool', { ok: false, type: 'news.error', error: msg });
      return true;
    }
  }

  // 4) 뉴스 상세 읽기: 번호 또는 키워드 → 요약 낭독
  if (/(읽어줘|자세히|상세|더 말해|읽어 봐|읽어봐|보여줘|자세히 보여줘|내용)/.test(lower)) {
    const isFresh = lastNewsList && lastNewsList.length > 0 && (Date.now() - lastNewsAt) <= NEWS_TTL_MS;
    if (!isFresh) return false;
    if (shouldDebounce('news.read', 200)) return true;

    try {
      const idx = extractIndexForPick(text, lastNewsList.length);
      const keyword = extractKeywordForPick(text);

      let pick = null;
      if (idx != null) {
        if (idx < 1 || idx > lastNewsList.length) {
          emitOnce(send, 'tool', { ok: true, type: 'news.read', text: `해당 순번의 기사가 없습니다. 1부터 ${lastNewsList.length} 사이로 말씀해 주세요.` });
          return true;
        }
        pick = lastNewsList[idx - 1];
      } else if (keyword) {
        pick = pickByKeyword(lastNewsList, keyword);
        if (!pick) {
          const fresh = await searchNews(keyword);
          const maxShow = Number(process.env.NAVER_NEWS_DISPLAY || 10);
          const sliced = (fresh || []).slice(0, maxShow);
          if (sliced.length > 0) {
            lastNewsList = sliced;
            lastNewsQuery = keyword;
            lastNewsAt = Date.now();
            pick = pickByKeyword(sliced, keyword) || sliced[0];
          }
        }
      } else {
        pick = lastNewsList[0];
      }

      if (!pick) {
        emitOnce(send, 'tool', { ok: true, type: 'news.read', text: '목록에서 기사를 찾지 못했습니다. 다시 말씀해 주세요.' });
        return true;
      }

      lastPicked = pick;

      const summary = await summarizeArticle(pick);
      const speak = `제목: ${pick.title}\n${summary}`;
      emitOnce(send, 'tool', {
        ok: true,
        type: 'news.read',
        text: speak,
        item: pick,
        query: lastNewsQuery,
      });
      return true;
    } catch (e) {
      const msg = e?.message || '뉴스 요약 실패';
      emitOnce(send, 'tool', { ok: false, type: 'news.error', error: msg });
      return true;
    }
  }

  // 4-b) 링크 열기: "링크", "클릭", "열어줘/열어봐", "이동"
  if (/(링크|클릭|열어줘|열어봐|이동)/.test(lower)) {
    const isFresh = lastNewsList && lastNewsList.length > 0 && (Date.now() - lastNewsAt) <= NEWS_TTL_MS;
    if (!isFresh && !lastPicked) return false;

    if (shouldDebounce('news.open_url', 200)) return true;

    const idx = extractIndexForPick(text, lastNewsList.length);
    const keyword = extractKeywordForPick(text);
    let target = lastPicked || null;

    if (idx != null && isFresh) {
      if (idx >= 1 && idx <= lastNewsList.length) target = lastNewsList[idx - 1];
    } else if (keyword && isFresh) {
      target = pickByKeyword(lastNewsList, keyword) || target;
    }
    if (!target && isFresh) target = lastNewsList[0];

    if (!target) {
      emitOnce(send, 'tool', { ok: false, type: 'news.open_url', error: '열 링크가 없습니다. 먼저 기사를 선택해 주세요.' });
      return true;
    }

    const url = target.link || target.originallink || '';
    if (!url) {
      emitOnce(send, 'tool', { ok: false, type: 'news.open_url', error: '이 기사에는 열 수 있는 링크가 없습니다.' });
      return true;
    }

    // 1) 사용자에게 안내 텍스트(채팅 표출용)
    emitOnce(send, 'tool', {
      ok: true,
      type: 'news.open_url',
      url,
      item: target,
      text: `링크를 열겠습니다: ${url}`,
    });

    // 2) 실제 액션 트리거용 "명령 이벤트" 추가 발행
    // SSE: event=command, data={ action:'open_url', url, title }
    // WS: { event:'command', action:'open_url', url, title }
    send('command', {
      action: 'open_url',
      url,
      title: target.title,
    });

    return true;
  }

  // 5) 알림/예약 테스트
  if (lower.includes('알림')) {
    emitOnce(send, 'tool', { ok: true, type: 'notification', message: '테스트 알림 예약 완료' });
    return true;
  }
  if (lower.includes('예약')) {
    emitOnce(send, 'tool', { ok: true, type: 'schedule', summary: '테스트 일정 생성', when: new Date(Date.now() + 3600_000).toISOString() });
    return true;
  }

  // 여기까지 어느 룰에도 해당 안 되면 LLM으로 넘김
  return false;
}

/**
 * 뉴스 검색 질의 추출
 */
function extractNewsQuery(utter) {
  const t = String(utter || '').trim();
  const cleaned = t
    .replace(/오늘|최신|최근|말해줘|읽어줘|읽어봐|기사거리|뉴스거리|뉴스|네이버/gi, '')
    .trim();
  return cleaned || '인공지능';
}

/**
 * 뉴스 상세 선택 키워드 추출
 */
function extractKeywordForPick(utter) {
  const t = String(utter || '').trim();
  return t
    .replace(/(첫.?번|두.?번|세.?번|네.?번|다섯.?번|여섯.?번|일곱.?번|여덟.?번|아홉.?번|열.?번|[0-9]+ ?번|[0-9]+ ?번째|첫.?번째|두.?번째|세.?번째|네.?번째|다섯.?번째|여섯.?번째|일곱.?번째|여덟.?번째|아홉.?번째|열.?번째|마지막|말해봐|말해줘|보여줘|보여봐|읽어줘|읽어봐|상세|자세히|그 중|그중|그거|요약|내용|보여줘|링크|클릭|열어줘|열어봐|이동)/gi, '')
    .trim();
}

/**
 * 순번 추출: 1-based index를 반환하거나 null
 */
function extractIndexForPick(utter, len) {
  const t = String(utter || '').trim();

  if (/(마지막)/.test(t)) {
    return len >= 1 ? len : null;
  }

  const numMatch = t.match(/(\d+)\s*(?:번|번째)?/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (!Number.isNaN(n)) return n;
  }

  const ordMap = {
    '첫': 1, '첫째': 1, '첫번째': 1, '첫 번': 1,
    '둘': 2, '두째': 2, '두 번째': 2, '두번째': 2,
    '셋': 3, '세째': 3, '세 번째': 3, '세번째': 3,
    '넷': 4, '네째': 4, '네 번째': 4, '네번째': 4,
    '다섯': 5, '다섯 번째': 5, '다섯번째': 5,
    '여섯': 6, '여섯 번째': 6, '여섯번째': 6,
    '일곱': 7, '일곱 번째': 7, '일곱번째': 7,
    '여덟': 8, '여덟 번째': 8, '여덟번째': 8,
    '아홉': 9, '아홉 번째': 9, '아홉번째': 9,
    '열': 10, '열 번째': 10, '열번째': 10,
  };

  for (const k of Object.keys(ordMap)) {
    if (t.includes(k)) return ordMap[k];
  }

  return null;
}

// 화면용 리스트 포맷
function formatNewsList(items) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  const dayOfWeek = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'][now.getDay()];
  
  const lines = items.map(v => `${v.idx}. ${v.title}`);
  return `${month}월 ${date}일 ${dayOfWeek} 기준 상위 ${items.length}건입니다.\n` + lines.join('\n') + `\n특정 기사를 들으시려면 제목의 핵심 단어 또는 순번으로 말씀해 주세요. 예) "두번째 읽어줘", "키워드 읽어줘"`;
}
