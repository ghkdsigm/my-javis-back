// src/tools/openweather.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

// 환경 변수
const API_KEY = process.env.OPENWEATHER_API_KEY || '';
const DEFAULT_CITY = process.env.OPENWEATHER_DEFAULT_CITY || 'Seoul,KR';

// Node 18 미만에서도 동작하도록 fetch 폴리필 자동 로드
async function ensureFetch() {
  if (typeof fetch === 'function') return fetch;
  const mod = await import('node-fetch');
  const f = (mod.default || mod);
  return f;
}

async function fetchJson(url) {
  const f = await ensureFetch();
  const res = await f(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenWeather ${res.status} ${res.statusText} ${body ? '- ' + body : ''}`);
  }
  return res.json();
}

/** KST 기준 YYYY-MM-DD 문자열 */
function ymdKST(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** KST 기준 "10월 23일 목요일" 라벨 */
function dateLabelKST(d = new Date()) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(d);
}

/** 한국어 도시명 변환 */
function localizeCity(name, country) {
  const n = String(name || '');
  const c = String(country || '');
  if (c === 'KR') {
    const map = {
      Seoul: '서울',
      Busan: '부산',
      Daegu: '대구',
      Incheon: '인천',
      Daejeon: '대전',
      Gwangju: '광주',
      Ulsan: '울산',
      Suwon: '수원',
      'Jeju City': '제주',
      Jeju: '제주',
    };
    if (map[n]) return map[n];
  }
  return n || '';
}

/** coord 기반 One Call 3.0 조회 (daily만 사용) */
async function getOneCallDailyByCoord(coord, params) {
  const { lon, lat } = coord || {};
  if (lon == null || lat == null) throw new Error('좌표 조회에 실패했습니다.');
  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,alerts&${params}`;
  return fetchJson(url);
}

/**
 * 자유 텍스트에서 '오늘/내일/이번주/다음주'와 도시를 추정
 */
export function parseWeatherIntent(text) {
  const t = String(text || '').toLowerCase();

  const wantToday = /(오늘|today)/.test(t);
  const wantTomorrow = /(내일|tomorrow)/.test(t);
  const wantThisWeek = /(이번주|주간|this week|weekly|week)/.test(t);
  const wantNextWeek = /(다음주|next week)/.test(t);

  let when = 'today';
  if (wantNextWeek) when = 'nextweek';
  else if (wantTomorrow) when = 'tomorrow';
  else if (wantThisWeek) when = 'week';

  const cityMap = [
    ['서울', 'Seoul,KR'], ['부산', 'Busan,KR'], ['대구', 'Daegu,KR'],
    ['인천', 'Incheon,KR'], ['대전', 'Daejeon,KR'], ['광주', 'Gwangju,KR'], ['울산', 'Ulsan,KR'],
    ['제주', 'Jeju City,KR'], ['수원', 'Suwon,KR'],
  ];
  let city = null;

  for (const [kw, q] of cityMap) {
    if (t.includes(kw)) { city = q; break; }
  }

  if (!city) {
    const m = t.match(/\b([a-z][a-z \-]+?)(?:,\s*([a-z]{2}))?\b/i);
    if (m) {
      city = m[2] ? `${m[1].trim()},${m[2].toUpperCase()}` : m[1].trim();
    }
  }

  if (!city) city = DEFAULT_CITY;
  return { when, city };
}

/**
 * 강수 질의 파서(오탐 방지 강화):
 * - '비'는 날씨 맥락에서만 인식 (비가/비와/비 올/비 오/비 내려/우산/예보/기상/날씨)
 * - 시간 토큰(오늘/내일/주간/today/tomorrow)이 있을 때만 확정
 * - '비용/비율/비밀번호/비전/비품/비슷/비교/비고' 등은 제외
 */
export function parsePrecipQuestion(text) {
  const raw = String(text || '');
  const t = raw.toLowerCase();

  const blacklist = /(비용|비율|비밀번호|비번|비전|비품|비교|비슷|비고|비대면)/;
  if (blacklist.test(raw)) return null;

  const temporal = /(오늘|내일|이번주|주간|today|tomorrow|this week)/i.test(raw);
  const weatherCtx = /(날씨|우산|예보|기상|기온)/i.test(raw);

  const rainLike = /(비(가|와|올|오| 내리| 오나| 오니| 오냐| 오는지)|rain)/i.test(raw.replace(/\s+/g, ' '));

  if ((rainLike && (temporal || weatherCtx))) {
    const when = /(내일|tomorrow)/i.test(raw) ? 'tomorrow' : 'today';
    const { city } = parseWeatherIntent(raw);
    return { when, kind: 'rain', city };
  }
  // 눈 의도도 동일하게 처리
  const snowLike = /(눈(이| 올| 오| 내리)|snow)/i.test(raw.replace(/\s+/g, ' '));
  if ((snowLike && (temporal || weatherCtx))) {
    const when = /(내일|tomorrow)/i.test(raw) ? 'tomorrow' : 'today';
    const { city } = parseWeatherIntent(raw);
    return { when, kind: 'snow', city };
  }
  return null;
}

/**
 * 강수 질의 응답 (/forecast 3시간 간격 사용)
 */
export async function getPrecipitationAnswer({ when, kind, city }) {
  if (!API_KEY) throw new Error('OPENWEATHER_API_KEY가 설정되어 있지 않습니다.');

  const base = 'https://api.openweathermap.org/data/2.5';
  const params = `appid=${encodeURIComponent(API_KEY)}&units=metric&lang=kr`;

  const cur = await fetchJson(`${base}/weather?q=${encodeURIComponent(city)}&${params}`);
  const cityKo = localizeCity(cur.name, cur.sys?.country);

  const fc = await fetchJson(`${base}/forecast?q=${encodeURIComponent(city)}&${params}`);

  const target = new Date();
  if (when === 'tomorrow') target.setDate(target.getDate() + 1);
  const targetYmd = ymdKST(target);
  const list = (fc.list || []).filter(x => x.dt_txt?.startsWith(targetYmd));

  const key = kind === 'snow' ? 'snow' : 'rain';
  const hits = list.filter(x => {
    const p = typeof x.pop === 'number' ? x.pop : 0;
    const k = x[key] && (x[key]['3h'] || x[key]);
    return (k && k > 0) || p >= 0.3;
  });

  const label = when === 'tomorrow' ? `내일 ${dateLabelKST(target)}` : `오늘 ${dateLabelKST(target)}`;
  if (hits.length === 0) {
    return { city: cityKo, when, kind, text: `${label}, ${cityKo} ${kind === 'snow' ? '눈' : '비'} 예상은 없습니다.`, details: [] };
  }

  const timeOf = tsTxt => `${tsTxt.slice(11, 13).replace(/^0/, '')}시`;
  const slots = hits.slice(0, 3).map(x => {
    const amount = x[key] && (x[key]['3h'] || x[key]) ? Math.round((x[key]['3h'] || x[key]) * 10) / 10 : 0;
    const prob = typeof x.pop === 'number' ? Math.round(x.pop * 100) : null;
    return `${timeOf(x.dt_txt)}${prob != null ? ` 강수 가능성 ${prob}%` : ''}${amount ? `, 예상 강수량 ${amount}mm` : ''}`;
  });

  return {
    city: cityKo,
    when,
    kind,
    text: `${label}, ${cityKo} ${kind === 'snow' ? '눈' : '비'} 가능성이 있습니다: ${slots.join(', ')}.`,
    details: hits,
  };
}

/**
 * 일반 날씨 응답
 */
export async function getWeather({ city, when }) {
  if (!API_KEY) throw new Error('OPENWEATHER_API_KEY가 설정되어 있지 않습니다.');

  const base = 'https://api.openweathermap.org/data/2.5';
  const params = `appid=${encodeURIComponent(API_KEY)}&units=metric&lang=kr`;

  const cur = await fetchJson(`${base}/weather?q=${encodeURIComponent(city)}&${params}`);
  const cityKo = localizeCity(cur.name, cur.sys?.country);

  if (when === 'nextweek') {
    const notice = '다음 주 예보는 현재 지원하지 않습니다. 이번 주 5일치까지만 제공해 드립니다.';
    return { type: 'nextweek', location: cityKo, daily: [], text: notice, limited: true };
  }

  if (when === 'week') {
    const one = await getOneCallDailyByCoord(cur.coord, params);
    const daily = (one.daily || []).slice(0, 7).map(d => ({
      dt: d.dt,
      temp_day: Math.round(d.temp?.day),
      temp_night: Math.round(d.temp?.night),
      desc: d.weather?.[0]?.description || '',
      label: dateLabelKST(new Date(d.dt * 1000)),
    }));
    const text = `${cityKo} 주간 예보입니다: ${daily.map(d => `${d.label} 낮 ${d.temp_day}도, 밤 ${d.temp_night}도, ${d.desc}`).join('. ')}.`;
    return { type: 'week', location: cityKo, daily, text };
  }

  const current = {
    temp: Math.round(cur.main?.temp),
    feels: Math.round(cur.main?.feels_like),
    desc: cur.weather?.[0]?.description || '',
    humidity: cur.main?.humidity,
    wind: Math.round((cur.wind?.speed || 0) * 10) / 10,
  };

  if (when === 'today') {
    const fc = await fetchJson(`${base}/forecast?q=${encodeURIComponent(city)}&${params}`);
    const label = `오늘 ${dateLabelKST(new Date())}`;
    const todayStr = ymdKST(new Date());
    const slots = (fc.list || []).filter(x => x.dt_txt?.startsWith(todayStr));
    const pick = hh => slots.find(x => x.dt_txt?.includes(` ${hh}:00:00`));
    const pm3 = pick('15'); const pm9 = pick('21');

    const s = [];
    s.push(`${label}, ${cityKo} 현재 ${current.desc}, ${current.temp}도(체감 ${current.feels}도), 습도 ${current.humidity}%, 바람 ${current.wind}m/s입니다.`);
    if (pm3) s.push(`오후(15시) ${Math.round(pm3.main.temp)}도, ${pm3.weather?.[0]?.description || ''}일 것으로 예상됩니다.`);
    if (pm9) s.push(`밤(21시) ${Math.round(pm9.main.temp)}도, ${pm9.weather?.[0]?.description || ''}일 것으로 예상됩니다.`);

    return { type: 'today', location: cityKo, now: current, text: s.join(' ') };
  }

  if (when === 'tomorrow') {
    const fc = await fetchJson(`${base}/forecast?q=${encodeURIComponent(city)}&${params}`);
    const d = new Date(); d.setDate(d.getDate() + 1);
    const label = `내일 ${dateLabelKST(d)}`;
    const target = ymdKST(d);
    const slots = (fc.list || []).filter(x => x.dt_txt?.startsWith(target));
    const pick = hh => slots.find(x => x.dt_txt?.includes(` ${hh}:00:00`));
    const am9 = pick('09'); const pm3 = pick('15'); const pm9 = pick('21');

    const s = [];
    s.push(`${label}, ${cityKo} 예보입니다.`);
    if (am9) s.push(`오전(09시) ${Math.round(am9.main.temp)}도, ${am9.weather?.[0]?.description || ''}일 것으로 예상됩니다.`);
    if (pm3) s.push(`오후(15시) ${Math.round(pm3.main.temp)}도, ${pm3.weather?.[0]?.description || ''}일 것으로 예상됩니다.`);
    if (pm9) s.push(`밤(21시) ${Math.round(pm9.main.temp)}도, ${pm9.weather?.[0]?.description || ''}일 것으로 예상됩니다.`);

    return { type: 'tomorrow', location: cityKo, now: current, text: s.join(' ') };
  }

  return {
    type: 'today',
    location: cityKo,
    now: current,
    text: `오늘 ${dateLabelKST(new Date())}, ${cityKo} 현재 ${current.desc}, ${current.temp}도입니다.`,
  };
}
