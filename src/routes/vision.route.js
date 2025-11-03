// src/routes/vision.route.js
// 코드 주석에 이모티콘은 사용하지 않습니다.
// 이미지 파일을 업로드 받아 Qwen2.5-VL-7B로 분석한다.

import { Router } from 'express';
import multer from 'multer';
import { openaiVisionOnce } from '../llm/openaiCompat.js';
import { wsSend } from '../ws.js';

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

/**
 * 한국어 문서형 정리 기본 프롬프트를 생성한다.
 * - 화이트보드/칠판/슬라이드/수기 메모처럼 텍스트가 많은 경우:
 *   1) 제목(있으면) → 2~4문장 핵심 요약 → 핵심 항목 불릿 리스트 → 액션 아이템(담당/기한) 순으로 정리
 *   2) 수치·날짜·결정사항을 정확히 보존하고, 의미를 해치지 않는 범위에서 오타만 보정
 *   3) 불필요한 카메라/조명/이미지 메타 설명 금지
 * - 텍스트가 거의 없는 사물/풍경 사진인 경우:
 *   1) 핵심 사물이나 장면을 한두 문장으로 간결하게 설명
 * - 항상 한국어로 작성하고, 결과는 마크다운 형식으로 출력
 * - 선택적으로 마지막에 'AI 의견/해석·제안' 섹션을 추가할 수 있다.
 */
function buildKoreanDocStylePrompt(userPrompt, wantOpinion = true) {
  const base = [
    '이미지(화이트보드/칠판/슬라이드/수기 메모 등)를 분석하라.',
    '보이는 텍스트만 사용하고, 읽기 어려운 부분은 추정하지 말고 빈칸 또는 "확인 필요"로 표기하라.',
    '출력은 반드시 한국어이며 GitHub Flavored Markdown으로 작성하라.',
    '# 제목',
    '## 핵심 요약',
    '- 2~4문장으로 사실만 요약.',
    '## 주요 항목',
    '- 판독된 블록/모듈 혹은 소제목 이름을 불릿으로 나열.',
    '## 시스템 구성 요소 표',
    '| 구역 | 구성요소 | 기능/역할 | 연결/인터페이스 | 비고 |',
    '|---|---|---|---|---|',
    '## 인터페이스/흐름',
    '- "A -> B : 설명" 형태로 나열.',
    '## ACTION',
    '- 보이면 담당/기한 표기.',
    '## 확인 필요 사항',
    '- 판독 불가/애매 항목을 목록화.',
  ];

  if (userPrompt && String(userPrompt).trim()) {
    base.push(`\n[사용자 추가 지시] ${String(userPrompt).trim()}`);
  }

  if (wantOpinion) {
    base.push(
      '\n---',
      '## AI 의견/해석·제안',
      '- 아래 항목은 사실과 분리된 추정/의견임을 명확히 하고, 근거가 되는 텍스트가 있으면 함께 인용하라.',
      '- 개선 제안 3~5개, 잠재 리스크 1~3개를 불릿으로 제시하라.',
      '- 각 항목 끝에 (확신도: 0.0~1.0) 형식으로 자신감을 표기하라.',
      '- 과도한 추정 금지. 원문 텍스트가 불명확하면 "가정"으로 표기.'
    );
  }

  return base.join('\n');
}

// multipart/form-data: fields = { sessionId, prompt, includeOpinion }, files = image(s)
router.post('/vision/analyze', upload.array('images', 6), async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || '');
    const userPrompt = String(req.body?.prompt || '');
    const includeOpinionRaw = String(req.body?.includeOpinion ?? 'true').toLowerCase();
    const includeOpinion = !(['false', '0', 'no'].includes(includeOpinionRaw));

    if (!sessionId) return res.status(400).json({ ok: false, error: 'sessionId required' });
    if (!req.files?.length) return res.status(400).json({ ok: false, error: 'no images' });

    const imagesBase64 = req.files.map(f => f.buffer.toString('base64'));
    const mimeTypes = req.files.map(f => f.mimetype || 'image/jpeg');

    // 이름을 instruction으로 바꿔서 전역/다른 prompt 식별자와 충돌 방지
    const instruction = buildKoreanDocStylePrompt(userPrompt, includeOpinion);

    const answer = await openaiVisionOnce({
      model: 'qwen2.5vl:7b',
      text: instruction,
      imagesBase64,
      mimeTypes,
    });

    wsSend(sessionId, { type: 'vision.result', text: answer });
    return res.json({ ok: true, text: answer, includeOpinion });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
