const nodemailer = require('nodemailer');
const {
  smtpHost,
  smtpPort,
  smtpSecure,
  smtpUser,
  smtpPass,
  mailFrom,
  brevoApiKey,
  sendgridApiKey,
  resendApiKey,
} = require('./env');

// Ưu tiên HTTP API (Brevo/SendGrid/Resend, cổng 443 — chạy được trên Render/Vercel).
// SMTP chỉ dùng khi không có HTTP API (hợp local; nhiều PaaS chặn cổng SMTP).
const useBrevo = Boolean(brevoApiKey);
const useSendgrid = Boolean(sendgridApiKey);
const useResend = Boolean(resendApiKey);
const useSmtp = Boolean(smtpHost && smtpUser && smtpPass);
const isMailConfigured = useBrevo || useSendgrid || useResend || useSmtp;

function buildContent(code) {
  return {
    subject: 'Mã đăng nhập Feelex QLDA',
    text:
      `Mã đăng nhập Feelex QLDA của bạn là: ${code}\n` +
      `Mã có hiệu lực trong ít phút. Không chia sẻ mã này cho bất kỳ ai.`,
    html:
      `<p>Mã đăng nhập <b>Feelex QLDA</b> của bạn là:</p>` +
      `<p style="font-size:26px;font-weight:700;letter-spacing:6px;margin:8px 0">${code}</p>` +
      `<p style="color:#64748b">Mã có hiệu lực trong ít phút. Không chia sẻ mã này cho bất kỳ ai. truy cập: https://qlda-rd.feelex.vn</p>`,
  };
}

// Tách "Tên <email>" hoặc "email" thành { name, email }.
function parseFrom(str) {
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(str || '');
  if (m) return { name: m[1] || undefined, email: m[2].trim() };
  if (str && str.includes('@')) return { email: str.trim() };
  return null;
}

async function postJson(url, headers, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gửi email lỗi (${res.status}): ${body}`);
    }
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Gửi email quá thời gian chờ (dịch vụ không phản hồi).');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaBrevo(email, code) {
  const from = parseFrom(mailFrom);
  if (!from) {
    throw new Error('Thiếu MAIL_FROM hợp lệ cho Brevo (vd: Feelex QLDA <email-da-verify@...>)');
  }
  const { subject, text, html } = buildContent(code);
  await postJson(
    'https://api.brevo.com/v3/smtp/email',
    { 'api-key': brevoApiKey, accept: 'application/json' },
    {
      sender: from, // { name?, email }
      to: [{ email }],
      subject,
      textContent: text,
      htmlContent: html,
    },
  );
  return true;
}

async function sendViaSendgrid(email, code) {
  const from = parseFrom(mailFrom);
  if (!from) {
    throw new Error('Thiếu MAIL_FROM hợp lệ cho SendGrid (vd: Feelex QLDA <noreply@ozovn.com>)');
  }
  const { subject, text, html } = buildContent(code);
  await postJson(
    'https://api.sendgrid.com/v3/mail/send',
    { Authorization: `Bearer ${sendgridApiKey}` },
    {
      personalizations: [{ to: [{ email }] }],
      from,
      subject,
      content: [
        { type: 'text/plain', value: text },
        { type: 'text/html', value: html },
      ],
    },
  );
  return true;
}

async function sendViaResend(email, code) {
  const { subject, text, html } = buildContent(code);
  await postJson(
    'https://api.resend.com/emails',
    { Authorization: `Bearer ${resendApiKey}` },
    {
      from: mailFrom || 'Feelex QLDA <onboarding@resend.dev>',
      to: [email],
      subject,
      text,
      html,
    },
  );
  return true;
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure, // true cho cổng 465, false cho 587/25 (STARTTLS)
      auth: { user: smtpUser, pass: smtpPass },
      // Timeout để không treo vô hạn nếu cổng SMTP bị chặn (vd trên Render).
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transporter;
}

async function sendViaSmtp(email, code) {
  const { subject, text, html } = buildContent(code);
  await getTransporter().sendMail({
    from: mailFrom || smtpUser,
    to: email,
    subject,
    text,
    html,
  });
  return true;
}

// Gửi mã OTP qua email. Trả về true nếu đã gửi thật.
async function sendLoginCode(email, code) {
  if (useBrevo) return sendViaBrevo(email, code);
  if (useSendgrid) return sendViaSendgrid(email, code);
  if (useResend) return sendViaResend(email, code);
  if (useSmtp) return sendViaSmtp(email, code);
  throw new Error('Chưa cấu hình dịch vụ gửi email');
}

module.exports = { isMailConfigured, sendLoginCode };
