// src/tools/mailer.js
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = +(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

const transporter = SMTP_HOST ? nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
}) : null;

async function sendMail({ to, subject, html }) {
  if (!transporter) throw new Error('smtp_not_configured');
  return transporter.sendMail({ from: SMTP_FROM, to, subject, html });
}

module.exports = { sendMail };
