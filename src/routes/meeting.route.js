// src/routes/meeting.route.js
// 코드 주석에 이모티콘은 사용하지 않습니다.

import { Router } from 'express';

const router = Router();

/**
 * 건강 체크
 * GET /api/meeting/ping
 */
router.get('/ping', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * 회의 요약 메일 발송
 * POST /api/meeting/send-summary
 * body: { to: string, subject?: string, summaryHtml?: string, summaryText?: string }
 *
 * 동작 방식:
 * - 서버에 nodemailer 패키지가 설치되어 있으면 SMTP로 발송
 * - nodemailer가 없거나 SMTP 환경변수가 비어있으면 400으로 이유를 안내
 * - summaryHtml 있으면 그대로 사용, 없으면 summaryText의 개행을 <br>로 변환하여 HTML 본문 생성
 */
router.post('/send-summary', async (req, res) => {
  try {
    const { to, subject, summaryHtml, summaryText } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: 'missing "to"' });

    // 동적 import: nodemailer가 없으면 캐치해서 안내하고 서버는 계속 동작
    let nodemailer;
    try {
      ({ default: nodemailer } = await import('nodemailer'));
    } catch (_e) {
      return res
        .status(400)
        .json({ ok: false, error: 'nodemailer_not_installed', fix: 'npm i nodemailer' });
    }

    const SMTP_HOST = process.env.SMTP_HOST || '';
    const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
    const SMTP_USER = process.env.SMTP_USER || '';
    const SMTP_PASS = process.env.SMTP_PASS || '';
    const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || '';

    if (!SMTP_HOST) {
      return res.status(400).json({ ok: false, error: 'smtp_not_configured' });
    }

    const html =
      summaryHtml ??
      (summaryText
        ? String(summaryText).replace(/\n/g, '<br>')
        : '<b>(요약 내용이 비어 있습니다)</b>');

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });

    const info = await transporter.sendMail({
      from: SMTP_FROM || undefined,
      to,
      subject: subject || '회의 요약',
      html,
    });

    return res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * 메일 앱 열기(클라이언트용 보조 엔드포인트)
 * POST /api/meeting/build-mailto
 * body: { to?: string, subject?: string, summaryText?: string }
 *
 * nodemailer 없이도 동작. 프론트에서 mailto 링크/인텐트로 열어 사용.
 */
router.post('/build-mailto', async (req, res) => {
  const { to = '', subject = '회의 요약', summaryText = '' } = req.body || {};
  const enc = (s) => encodeURIComponent(String(s || ''));
  const body = summaryText ? summaryText : '(요약 내용이 비어 있습니다)';
  const link = `mailto:${enc(to)}?subject=${enc(subject)}&body=${enc(body)}`;
  return res.json({ ok: true, mailto: link });
});

export default router;
