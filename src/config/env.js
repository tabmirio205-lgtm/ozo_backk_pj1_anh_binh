require('dotenv').config();

function parseList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Như parseList nhưng GIỮ NGUYÊN hoa/thường (open_id của Lark phân biệt hoa thường).
function parseListRaw(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  // Auth
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  otpTtlMinutes: Number(process.env.OTP_TTL_MINUTES || 10),
  otpMaxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 5),
  // Chỉ cho phép email thuộc domain này đăng nhập (để trống = cho tất cả)
  allowedEmailDomain: (process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase(),
  // Mã bí mật chung để PIC nâng quyền lên Quản lý (sửa tất cả)
  managerCode: (process.env.MANAGER_CODE || '').trim(),

  // Gửi OTP qua email (HTTP API — dùng cho deploy trên Render/Vercel vì SMTP bị chặn).
  brevoApiKey: (process.env.BREVO_API_KEY || '').trim(),
  sendgridApiKey: (process.env.SENDGRID_API_KEY || '').trim(),
  resendApiKey: (process.env.RESEND_API_KEY || '').trim(),
  // SMTP — dùng cho local (nhiều PaaS chặn cổng SMTP).
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || '',

  // Cloudinary (lưu file/ảnh đính kèm)
  cloudinaryCloudName: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
  cloudinaryApiKey: (process.env.CLOUDINARY_API_KEY || '').trim(),
  cloudinaryApiSecret: (process.env.CLOUDINARY_API_SECRET || '').trim(),

  // Chatbot LLM: chọn nhà cung cấp (groq | gemini | anthropic)
  llmProvider: (process.env.LLM_PROVIDER || 'groq').trim().toLowerCase(),

  // Gemini (bộ não chatbot)
  geminiApiKey: (process.env.GEMINI_API_KEY || '').trim(),
  geminiModel: (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),

  // Groq (free, Llama 3.3 70B, OpenAI-compatible)
  groqApiKey: (process.env.GROQ_API_KEY || '').trim(),
  groqModel: (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim(),

  // Anthropic Claude (Messages API) — thông minh hơn, có phí theo token.
  anthropicApiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
  anthropicModel: (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim(),

  // Lark bot (chatbot QLDA qua Lark chat)
  larkAppId: (process.env.LARK_APP_ID || '').trim(),
  larkAppSecret: (process.env.LARK_APP_SECRET || '').trim(),
  larkEncryptKey: (process.env.LARK_ENCRYPT_KEY || '').trim(),
  larkVerifyToken: (process.env.LARK_VERIFY_TOKEN || '').trim(),
  // Miền API: larksuite.com (quốc tế) hoặc feishu.cn (TQ). VN dùng larksuite.
  // Tái dùng LARK_BASE_URL nếu .env đã có (app Lark cũ), fallback LARK_DOMAIN.
  larkDomain: (process.env.LARK_BASE_URL || process.env.LARK_DOMAIN || 'https://open.larksuite.com').trim(),

  // Nhắc việc cho PIC qua Lark (scheduler chạy 8–17h giờ VN, mỗi giờ 1 lần).
  // Đặt REMINDERS_ENABLED=false để tắt.
  remindersEnabled: String(process.env.REMINDERS_ENABLED || 'true').toLowerCase() !== 'false',

  // Người theo dõi: nhận DM MỌI bước 'Đã xong'/'Bỏ qua' (ngoài trưởng phòng của bước đó).
  // Điền open_id lấy từ cột open_id bảng pic_members, nhiều người cách nhau dấu phẩy.
  stepDoneWatcherOpenIds: parseListRaw(process.env.STEP_DONE_WATCHER_OPEN_IDS),

  // Báo cáo tiến độ gửi vào nhóm Lark mỗi 9h sáng (giờ VN).
  // LARK_REPORT_CHAT_ID: chat_id nhóm nhận báo cáo (nhiều nhóm cách nhau dấu phẩy).
  // Bỏ trống -> tự gửi vào tất cả nhóm mà bot tham gia.
  larkReportChatId: (process.env.LARK_REPORT_CHAT_ID || '').trim(),
  // URL app cho người dùng truy cập cập nhật công việc.
  appUrl: (process.env.APP_URL || 'https://qlda-rd.feelex.vn').trim(),
};
