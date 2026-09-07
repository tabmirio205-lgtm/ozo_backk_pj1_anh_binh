// Báo cáo tiến độ tổng gửi vào NHÓM Lark mỗi 9h sáng (giờ VN).
// Gộp toàn bộ dự án: quá hạn, tới hạn hôm nay, sắp tới hạn (≤2 ngày) + chi tiết từng bước.
// Hạn (due) tính động bằng computeAllDates.

const { listProjectsWithNodes } = require('../projectService');
const { computeAllDates } = require('../../utils/datePlanner');
const { sendText, listChats } = require('../lark/larkClient');
const { getSupabaseClient } = require('../../config/supabaseClient');
const { isLeaderLabel } = require('../picMembersService');
const { picText } = require('../../utils/pic');
const { larkReportChatId, appUrl } = require('../../config/env');

const TZ = 'Asia/Ho_Chi_Minh';
const DONE = new Set(['Đã xong', 'Bỏ qua']);

function vnToday() {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d, iso, utc: Date.UTC(y, m - 1, d) };
}

// Chống gửi trùng qua bảng sent_reminders (kind='daily_report', dedup_key=ngày ISO).
// Nếu bảng chưa tạo -> trả known=false để không chặn (vẫn gửi, dựa dedup RAM).
async function reportAlreadySent(dateIso) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('sent_reminders')
    .select('id')
    .eq('kind', 'daily_report')
    .eq('dedup_key', dateIso)
    .limit(1);
  if (error) return { known: false, sent: false };
  return { known: true, sent: (data || []).length > 0 };
}

async function markReportSent(dateIso) {
  const supabase = getSupabaseClient();
  await supabase
    .from('sent_reminders')
    .upsert(
      [{ project_id: 0, node_id: '-', kind: 'daily_report', dedup_key: dateIso }],
      { onConflict: 'project_id,node_id,kind,dedup_key', ignoreDuplicates: true },
    );
}

function fmtDMY(y, m, d) {
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

// Nhãn PIC hiển thị trên báo cáo:
//  - có người   -> "Tên người - Phòng"
//  - nhãn vai trò ("Trưởng phòng X") -> giữ nguyên (đã có tên phòng)
//  - chưa gán   -> "chưa gán - Phòng" (biết phòng nào cần phân), hoặc "chưa gán"
function picLabel(node) {
  const name = picText(node.pic);
  const dept = node.dept && String(node.dept).trim();
  if (!name) return dept ? `chưa gán - ${dept}` : 'chưa gán';
  // Nhiều PIC cùng phòng -> "A, B - Phòng". Nhãn vai trò giữ nguyên.
  if (isLeaderLabel(name)) return name;
  return dept ? `${name} - ${dept}` : name;
}

async function computeReport() {
  const today = vnToday();
  const projects = await listProjectsWithNodes();
  const overdue = [];
  const dueToday = [];
  const dueSoon = [];

  for (const { project, nodes } of projects) {
    // Chỉ báo cáo dự án ĐANG HOẠT ĐỘNG. Bỏ qua Pending/Hoàn tất.
    // Dự án chưa có status (DB cũ) coi như "Đang hoạt động".
    const projStatus = (project.status || '').trim() || 'Đang hoạt động';
    if (projStatus !== 'Đang hoạt động') continue;
    const dates = computeAllDates({ project, nodes });
    for (const node of nodes) {
      if (DONE.has(node.status)) continue;
      const due = dates[node.node_id]?.due;
      if (!due) continue;
      const dueUtc = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
      const diff = Math.round((dueUtc - today.utc) / 86400000);
      const rec = {
        project,
        node,
        pic: picLabel(node),
        dueLabel: fmtDMY(due.getFullYear(), due.getMonth() + 1, due.getDate()),
        diff,
      };
      if (diff < 0) overdue.push({ ...rec, lateDays: -diff });
      else if (diff === 0) dueToday.push(rec);
      else if (diff <= 2) dueSoon.push(rec);
    }
  }

  overdue.sort((a, b) => b.lateDays - a.lateDays);
  dueSoon.sort((a, b) => a.diff - b.diff);
  return { today, overdue, dueToday, dueSoon };
}

function line(r) {
  return `• [${r.project.code}] ${r.project.name || ''} — ${r.node.node_id} ${r.node.node_name || ''} — PIC: ${r.pic} (hạn ${r.dueLabel})`;
}

function formatReport(rep) {
  const L = [];
  L.push('📊 BÁO CÁO TIẾN ĐỘ DỰ ÁN');
  L.push(`🗓️ Ngày cập nhật: ${fmtDMY(rep.today.y, rep.today.m, rep.today.d)}`);
  L.push('');

  L.push(`⚠️ Quá hạn: ${rep.overdue.length} bước`);
  rep.overdue.forEach((r) =>
    L.push(`• [${r.project.code}] ${r.project.name || ''} — ${r.node.node_id} ${r.node.node_name || ''} — PIC: ${r.pic} (quá ${r.lateDays} ngày, hạn ${r.dueLabel})`),
  );
  L.push('');

  L.push(`🔴 Tới hạn hôm nay: ${rep.dueToday.length} bước`);
  rep.dueToday.forEach((r) => L.push(line(r)));
  L.push('');

  L.push(`🟡 Sắp tới hạn (≤2 ngày): ${rep.dueSoon.length} bước`);
  rep.dueSoon.forEach((r) => L.push(line(r)));
  L.push('');

  L.push(`💬 PIC Nhắn tin với bot để cập nhật công việc, hoặc truy cập ${appUrl}`);
  return L.join('\n');
}

// Xác định danh sách chat_id nhóm nhận báo cáo.
async function resolveChatIds() {
  if (larkReportChatId) {
    return larkReportChatId.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const chats = await listChats();
  return chats.filter((c) => c.chat_mode === 'group').map((c) => c.chat_id);
}

// Gửi báo cáo. dryRun=true -> chỉ xem trước. force=true -> gửi lại dù đã gửi hôm nay.
async function sendDailyReport({ dryRun = false, force = false } = {}) {
  const rep = await computeReport();
  const text = formatReport(rep);
  const counts = {
    overdue: rep.overdue.length,
    dueToday: rep.dueToday.length,
    dueSoon: rep.dueSoon.length,
  };

  if (dryRun) return { ok: true, dryRun: true, counts, text };

  // Chống trùng: mỗi ngày chỉ gửi 1 lần (trừ khi force). Deploy/restart không gửi lại.
  if (!force) {
    const chk = await reportAlreadySent(rep.today.iso);
    if (chk.known && chk.sent) {
      return { ok: true, skipped: true, reason: `đã gửi báo cáo ngày ${rep.today.iso}`, counts };
    }
  }

  const chatIds = await resolveChatIds();
  if (!chatIds.length) {
    return { ok: false, error: 'Không tìm thấy nhóm nào (bot đã được add vào nhóm chưa? hoặc set LARK_REPORT_CHAT_ID).', counts };
  }
  const sentTo = [];
  for (const cid of chatIds) {
    const r = await sendText(cid, text);
    sentTo.push({ chat_id: cid, ok: r?.code === 0, msg: r?.msg });
  }
  // Chỉ đánh dấu đã gửi khi có ít nhất 1 nhóm nhận thành công.
  if (sentTo.some((s) => s.ok)) await markReportSent(rep.today.iso);
  return { ok: true, counts, sentTo };
}

module.exports = { computeReport, formatReport, sendDailyReport };
