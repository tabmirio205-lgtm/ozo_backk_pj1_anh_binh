const { verifyToken } = require('../services/authService');

function getTokenFromReq(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

// Yêu cầu đã đăng nhập. Gắn req.user = { id, email, role, picName }.
function requireAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }
  try {
    const payload = verifyToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      picName: payload.picName || null,
      leadDepts: Array.isArray(payload.leadDepts) ? payload.leadDepts : [],
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn' });
  }
}

// Yêu cầu quyền Quản lý (sửa tất cả). Dùng SAU requireAuth.
function requireManager(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Chưa đăng nhập' });
  if (req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Chỉ Quản lý mới có quyền này' });
  }
  next();
}

// Khách "chỉ xem" (role='guest', vào bằng nút Chỉ xem ở trang đăng nhập) chỉ được
// đọc ĐÚNG endpoint nuôi bảng "Ngày hàng về" (G3) ở trang Milestone. Dùng NGAY SAU
// requireAuth khi mount /api/projects — req.path lúc đó đã bỏ tiền tố mount.
function restrictGuest(req, res, next) {
  if (req.user?.role !== 'guest') return next();
  if (req.method === 'GET' && req.path === '/with-nodes') return next();
  return res.status(403).json({ error: 'Chế độ chỉ xem: không truy cập được mục này' });
}

// Chặn hoàn toàn guest (các API không phục vụ bảng Ngày hàng về).
function denyGuest(req, res, next) {
  if (req.user?.role === 'guest') {
    return res.status(403).json({ error: 'Chế độ chỉ xem: không truy cập được mục này' });
  }
  next();
}

module.exports = { requireAuth, requireManager, restrictGuest, denyGuest };
