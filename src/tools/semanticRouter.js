// src/tools/semanticRouter.js
const { embedMany, embedOne } = require('../utils/embeddings'); // 2-2 참조
const CANDS = [
  { label: 'weather', seeds: ['오늘 날씨 어때?', '비 오니?', '기온 알려줘', '우산 필요해?'] },
  { label: 'news',    seeds: ['뉴스 알려줘', '최근 소식', '헤드라인 뭐야', '이슈 요약해줘'] },
  { label: 'meeting_query', seeds: ['회의 요약해줘', '회의 메일로 보내줘', '방금 회의 정리'] },
  { label: 'smalltalk', seeds: ['안녕', '대화하자', '하루 어땠어?'] },
];

let SEED_VECS = null;

async function warmup() {
  if (SEED_VECS) return;
  const seedTexts = CANDS.flatMap(c => c.seeds.map(s => ({ label: c.label, text: s })));
  const vecs = await embedMany(seedTexts.map(x => x.text));
  SEED_VECS = seedTexts.map((x, i) => ({ label: x.label, vec: vecs[i] }));
}

function cosine(a, b) {
  let dot=0, na=0, nb=0;
  for (let i=0;i<a.length;i++){ dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-9);
}

async function routeByEmbedding(text) {
  await warmup();
  const v = await embedOne(text);
  let best = { label: 'other', score: -1 };
  for (const s of SEED_VECS) {
    const c = cosine(v, s.vec);
    if (c > best.score) best = { label: s.label, score: c };
  }
  // 임계치(조정 가능)
  if (best.score < 0.45) return 'other';
  return best.label;
}

module.exports = { routeByEmbedding };
