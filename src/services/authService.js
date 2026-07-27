const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { getSupabaseClient } = require('../config/supabaseClient');
const { isMailConfigured, sendLoginCode } = require('../config/mailer');
const { getMemberByEmail, getMemberByOpenId, leadDeptsOf } = require('./picMembersService');
const {
  jwtSecret,
  jwtExpiresIn,
  otpTtlMinutes,
  otpMaxAttempts,
  allowedEmailDomain,
  managerCode,
} = require('../config/env');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Vai trò khi đăng nhập: PIC (nếu email nằm trong pic_members) hoặc viewer.
// Trưởng phòng (is_leader) là PIC có thêm leadDepts = [phòng mình quản lý].
async function resolveRole(email) {
  const member = await getMemberByEmail(email);
  if (member && member.pic_name) {
    return { role: 'PIC', picName: member.pic_name, leadDepts: leadDeptsOf(member) };
  }
  return { role: 'viewer', picName: null, leadDepts: [] };
}

// Vai trò theo open_id Lark (đăng nhập qua bot). Kèm email nếu member có.
async function resolveRoleByOpenId(openId) {
  const member = await getMemberByOpenId(openId);
  if (member && member.pic_name) {
    return {
      role: 'PIC',
      picName: member.pic_name,
      leadDepts: leadDeptsOf(member),
      email: member.email || null,
    };
  }
  return { role: 'viewer', picName: null, leadDepts: [], email: null };
}

function hashCode(email, code) {
  return crypto
    .createHmac('sha256', jwtSecret)
    .update(`${email}:${code}`)
    .digest('hex');
}

function generateCode() {
  // 6 chữ số, không bắt đầu bằng 0 để luôn đủ 6 ký tự
  return String(crypto.randomInt(100000, 1000000));
}

// Bước 1: yêu cầu mã đăng nhập -> gửi qua Lark (hoặc log ở dev).
async function requestLoginCode(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    const err = new Error('Email không hợp lệ');
    err.status = 400;
    throw err;
  }
  if (allowedEmailDomain && !email.endsWith(`@${allowedEmailDomain}`)) {
    const err = new Error(`Chỉ chấp nhận email @${allowedEmailDomain}`);
    err.status = 403;
    throw err;
  }

  const supabase = getSupabaseClient();
  const code = generateCode();
  const codeHash = hashCode(email, code);
  const expiresAt = new Date(Date.now() + otpTtlMinutes * 60_000).toISOString();

  // Vô hiệu các mã cũ chưa dùng của email này.
  await supabase
    .from('login_codes')
    .update({ consumed: true })
    .eq('email', email)
    .eq('consumed', false);

  const { error } = await supabase.from('login_codes').insert([
    {
      email,
      code_hash: codeHash,
      expires_at: expiresAt,
      consumed: false,
      attempts: 0,
    },
  ]);
  if (error) throw error;

  let delivered = 'email';
  if (isMailConfigured) {
    await sendLoginCode(email, code);
  } else {
    // Chế độ dev: chưa cấu hình SMTP -> in mã ra console để test.
    delivered = 'console';
    console.log(`\n[DEV OTP] Mã đăng nhập cho ${email}: ${code}\n`);
  }

  return { ok: true, delivered, ttlMinutes: otpTtlMinutes };
}

// Bước 2: xác thực mã -> tạo/cập nhật user, phát JWT.
async function verifyLoginCode(rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode || '').trim();
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    const err = new Error('Email hoặc mã không hợp lệ');
    err.status = 400;
    throw err;
  }

  const supabase = getSupabaseClient();
  const { data: rows, error } = await supabase
    .from('login_codes')
    .select('*')
    .eq('email', email)
    .eq('consumed', false)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;

  const record = rows && rows[0];
  if (!record) {
    const err = new Error('Chưa yêu cầu mã hoặc mã đã dùng. Vui lòng lấy mã mới.');
    err.status = 400;
    throw err;
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    await supabase.from('login_codes').update({ consumed: true }).eq('id', record.id);
    const err = new Error('Mã đã hết hạn. Vui lòng lấy mã mới.');
    err.status = 400;
    throw err;
  }

  if (record.attempts >= otpMaxAttempts) {
    await supabase.from('login_codes').update({ consumed: true }).eq('id', record.id);
    const err = new Error('Nhập sai quá số lần cho phép. Vui lòng lấy mã mới.');
    err.status = 429;
    throw err;
  }

  const ok = crypto.timingSafeEqual(
    Buffer.from(record.code_hash),
    Buffer.from(hashCode(email, code)),
  );
  if (!ok) {
    await supabase
      .from('login_codes')
      .update({ attempts: record.attempts + 1 })
      .eq('id', record.id);
    const err = new Error('Mã không đúng');
    err.status = 400;
    throw err;
  }

  // Đúng mã -> tiêu thụ mã.
  await supabase.from('login_codes').update({ consumed: true }).eq('id', record.id);

  const { role, picName, leadDepts } = await resolveRole(email);

  // Upsert user, ghi lại vai trò + tên PIC + thời điểm đăng nhập.
  const { data: user, error: upsertError } = await supabase
    .from('app_users')
    .upsert(
      { email, role, name: picName, last_login_at: new Date().toISOString() },
      { onConflict: 'email' },
    )
    .select('*')
    .single();
  if (upsertError) throw upsertError;

  const token = jwt.sign(
    { sub: user.id, email: user.email, role, picName, leadDepts },
    jwtSecret,
    { expiresIn: jwtExpiresIn },
  );

  return {
    token,
    user: { id: user.id, email: user.email, role, picName, leadDepts },
  };
}

// === Đăng nhập qua bot Lark (không cần email) ===
// Bot gọi khi user nhắn "đăng nhập": cấp OTP gắn với open_id, DM lại cho họ.
// Chỉ cấp cho người là PIC (có trong pic_members). Trả { ok, code, ttlMinutes }.
async function issueLoginCodeForOpenId(openId) {
  const oid = String(openId || '').trim();
  if (!oid) return { ok: false, reason: 'no_open_id' };

  const member = await getMemberByOpenId(oid);
  if (!member || !member.pic_name) {
    return { ok: false, reason: 'not_pic' };
  }

  const supabase = getSupabaseClient();
  const code = generateCode();
  const codeHash = hashCode(oid, code); // gắn mã với open_id
  const expiresAt = new Date(Date.now() + otpTtlMinutes * 60_000).toISOString();

  // Vô hiệu các mã cũ chưa dùng của open_id này.
  await supabase
    .from('login_codes')
    .update({ consumed: true })
    .eq('open_id', oid)
    .eq('consumed', false);

  const { error } = await supabase.from('login_codes').insert([
    {
      open_id: oid,
      email: member.email || null,
      code_hash: codeHash,
      expires_at: expiresAt,
      consumed: false,
      attempts: 0,
    },
  ]);
  if (error) throw error;

  return { ok: true, code, ttlMinutes: otpTtlMinutes, picName: member.pic_name };
}

// Tạo/cập nhật app_users theo open_id (email có thể null với người dùng SĐT).
async function upsertAppUserByOpenId({ openId, email, role, picName }) {
  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();

  // Tìm dòng hiện có: ưu tiên open_id, rồi email (dữ liệu cũ đăng nhập bằng mail).
  let existing = null;
  {
    const { data } = await supabase.from('app_users').select('*').eq('open_id', openId).maybeSingle();
    if (data) existing = data;
  }
  if (!existing && email) {
    const { data } = await supabase.from('app_users').select('*').eq('email', email).maybeSingle();
    if (data) existing = data;
  }

  if (existing) {
    const { data, error } = await supabase
      .from('app_users')
      .update({ open_id: openId, email: email || existing.email || null, role, name: picName, last_login_at: nowIso })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabase
    .from('app_users')
    .insert([{ open_id: openId, email: email || null, role, name: picName, last_login_at: nowIso }])
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// Web nhập OTP (chỉ mã, không email) -> tìm mã theo open_id -> phát JWT.
// Web tự biết PIC nào vì mã đã gắn với open_id lúc bot cấp.
async function verifyLoginByBotCode(rawCode) {
  const code = String(rawCode || '').trim();
  if (!/^\d{6}$/.test(code)) {
    const err = new Error('Mã không hợp lệ'); err.status = 400; throw err;
  }

  const supabase = getSupabaseClient();
  const nowIso = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from('login_codes')
    .select('*')
    .eq('consumed', false)
    .not('open_id', 'is', null)
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;

  // Chỉ có mã (không open_id) -> thử khớp hash với từng ứng viên còn hiệu lực.
  const matches = [];
  for (const r of rows || []) {
    const expected = hashCode(r.open_id, code);
    if (
      r.code_hash &&
      r.code_hash.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(r.code_hash), Buffer.from(expected))
    ) {
      matches.push(r);
    }
  }
  if (matches.length === 0) {
    const err = new Error('Mã không đúng hoặc đã hết hạn. Nhắn "đăng nhập" cho bot để lấy mã mới.');
    err.status = 400;
    throw err;
  }
  // Hiếm: 2 người cùng mã đang hiệu lực -> không xác định được ai, buộc lấy mã mới.
  if (matches.length > 1) {
    const err = new Error('Mã bị trùng, không xác định được tài khoản. Nhắn "đăng nhập" cho bot để lấy mã mới.');
    err.status = 409;
    throw err;
  }
  const record = matches[0];

  await supabase.from('login_codes').update({ consumed: true }).eq('id', record.id);

  const { role, picName, leadDepts, email } = await resolveRoleByOpenId(record.open_id);
  const user = await upsertAppUserByOpenId({ openId: record.open_id, email, role, picName });

  const token = jwt.sign(
    { sub: user.id, email: email || null, role, picName, leadDepts, openId: record.open_id },
    jwtSecret,
    { expiresIn: jwtExpiresIn },
  );

  return {
    token,
    user: { id: user.id, email: email || null, role, picName, leadDepts },
  };
}

// === Khách "chỉ xem" ===
// Không cần OTP, không có dòng trong app_users (sub=0 -> chỉ dùng để ký JWT).
// Vai trò 'guest' chỉ đọc được danh sách dự án cho bảng "Ngày hàng về" (G3) ở
// trang Milestone; mọi API khác bị chặn ở middleware restrictGuest/denyGuest.
function issueGuestToken() {
  const user = { id: 0, email: null, role: 'guest', picName: null, leadDepts: [] };
  const token = jwt.sign(
    { sub: 0, email: null, role: 'guest', picName: null, leadDepts: [] },
    jwtSecret,
    { expiresIn: jwtExpiresIn },
  );
  return { token, user };
}

// Nâng quyền lên Quản lý bằng mã bí mật chung -> phát JWT mới role='manager'.
function elevateToManager(currentUser, code) {
  // Khách chỉ xem không gắn với tài khoản nào (sub=0) -> phải đăng nhập thật trước.
  if (currentUser?.role === 'guest') {
    const err = new Error('Chế độ chỉ xem không nâng quyền được. Vui lòng đăng nhập.');
    err.status = 403;
    throw err;
  }
  if (!managerCode) {
    const err = new Error('Mã quản lý chưa được cấu hình trên máy chủ');
    err.status = 400;
    throw err;
  }
  if (String(code || '').trim() !== managerCode) {
    const err = new Error('Mã quản lý không đúng');
    err.status = 403;
    throw err;
  }
  const leadDepts = currentUser.leadDepts || [];
  const token = jwt.sign(
    {
      sub: currentUser.id,
      email: currentUser.email,
      role: 'manager',
      picName: currentUser.picName || null,
      leadDepts,
    },
    jwtSecret,
    { expiresIn: jwtExpiresIn },
  );
  return {
    token,
    user: {
      id: currentUser.id,
      email: currentUser.email,
      role: 'manager',
      picName: currentUser.picName || null,
      leadDepts,
    },
  };
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret);
}

async function getUserById(id) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('app_users')
    .select('id,email,role,name')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  requestLoginCode,
  verifyLoginCode,
  issueLoginCodeForOpenId,
  verifyLoginByBotCode,
  issueGuestToken,
  elevateToManager,
  verifyToken,
  getUserById,
  resolveRole,
};
