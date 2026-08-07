// Nhắc việc cho PIC qua Lark DM. Các loại (kind):
//   - assigned     : việc mới được giao (node có PIC) -> GỬI NGAY khi phân PIC (event),
//                    không quét theo giờ nữa; xem notifyAssignment().
//   - due_soon     : trước hạn ~24h (hạn = ngày mai theo giờ VN) -> nhắc 1 lần cho mỗi mốc hạn
//   - overdue      : quá hạn -> nhắc MỖI NGÀY 1 lần cho tới khi 'Đã xong'/'Bỏ qua'
//                    (bước 'Tạm dừng' KHÔNG nhắc — xem SILENT bên dưới)
//   - started      : bước trước xong -> bước kế tiếp mở khoá; báo PIC bước kế tiếp.
//   - completed    : bước vừa 'Đã xong'/'Bỏ qua' -> báo trưởng phòng của bước.
//   - date_changed : ngày dự kiến của bước bị dời -> báo PIC bước đó (event, khi sửa bước).
// Chống gửi trùng bằng bảng public.sent_reminders (dedup theo project/node/kind/dedup_key).
// Hạn (due) tính động bằng computeAllDates — không lưu sẵn trong DB.

const { listProjectsWithNodes, getProjectDetail } = require('../projectService');
const { getSupabaseClient } = require('../../config/supabaseClient');
const { computeAllDates, isoLocal } = require('../../utils/datePlanner');
const { sendTextByEmail, sendTextByOpenId, isLarkConfigured } = require('../lark/larkClient');
const { remindersEnabled, stepDoneWatcherOpenIds, appUrl } = require('../../config/env');
const { getDeptLeaderMap, isLeaderLabel, deptFromLeaderLabel } = require('../picMembersService');
const { toPicArray, picText } = require('../../utils/pic');

const TZ = 'Asia/Ho_Chi_Minh';
const DONE = new Set(['Đã xong', 'Bỏ qua']);
// Bước KHÔNG gửi DM cho PIC: đã kết thúc, hoặc đang 'Tạm dừng' (giục người ta làm
// việc đang bị dừng là vô nghĩa — trước đây bước Tạm dừng vẫn bị nhắc quá hạn mỗi
// ngày, vô hạn, vì nó không bao giờ tự thoát trạng thái).
const SILENT = new Set([...DONE, 'Tạm dừng']);

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Ngày hôm nay theo giờ VN, kèm mốc UTC-midnight để trừ ngày an toàn.
function vnToday() {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d, iso, utc: Date.UTC(y, m - 1, d) };
}

function fmtDMY(y, m, d) {
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function fmtDate(d) {
  return fmtDMY(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// '2026-07-20' -> '20/07/2026' (ảnh chụp ngày dự kiến lưu dạng ISO).
function fmtIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

// Link mở thẳng trang dự án của bước (route frontend: /projects/:projectId).
// Lark tự nhận diện URL trần thành link bấm được, nên gửi URL nguyên dạng.
function projectUrl(project) {
  return `${appUrl.replace(/\/+$/, '')}/projects/${project.id}`;
}

// Map pic_name (chuẩn hoá) -> { open_id, email } từ pic_members. Gửi ưu tiên
// open_id (tới được cả người không có email trên Lark), fallback email.
// Đọc graded để không vỡ nếu DB chưa có cột open_id.
async function loadPicContactMap() {
  const supabase = getSupabaseClient();
  let rows = null;
  for (const spec of ['pic_name,open_id,email', 'pic_name,email']) {
    const { data, error } = await supabase.from('pic_members').select(spec);
    if (!error) { rows = data; break; }
  }
  const map = new Map();
  for (const row of rows || []) {
    const open_id = (row.open_id || '').trim() || null;
    const email = (row.email || '').trim() || null;
    if (row.pic_name && (open_id || email)) {
      map.set(norm(row.pic_name), { open_id, email });
    }
  }
  return map;
}

// Bản đồ dept -> liên hệ TRƯỞNG PHÒNG (để quy nhãn "Trưởng phòng X" về người thật).
// Chỉ dùng cho TIN GIAO VIỆC (assigned), KHÔNG dùng cho nhắc hạn/báo cáo nhóm.
async function loadLeaderContactMap(contactMap) {
  const deptLeader = await getDeptLeaderMap(); // { dept: pic_name }
  const map = new Map();
  for (const [dept, picName] of Object.entries(deptLeader || {})) {
    const c = contactMap.get(norm(picName));
    if (c && (c.open_id || c.email)) map.set(dept, c);
  }
  return map;
}

// Tìm liên hệ để GIAO VIỆC: theo tên PIC trong danh bạ; nếu là nhãn "Trưởng phòng
// X" thì quy về trưởng phòng của phòng X. Trả contact | null.
function resolveAssignContact(pic, contactMap, leaderMap) {
  const direct = contactMap.get(norm(pic));
  if (direct && (direct.open_id || direct.email)) return direct;
  if (isLeaderLabel(pic)) {
    const dept = deptFromLeaderLabel(pic);
    const l = leaderMap.get(dept);
    if (l && (l.open_id || l.email)) return l;
  }
  return null;
}

// Duyệt tất cả dự án -> danh sách nhắc ứng viên (chưa dedupe, chưa gắn email).
async function computeReminderItems() {
  const today = vnToday();
  const projects = await listProjectsWithNodes();
  const items = [];

  for (const { project, nodes } of projects) {
    const dates = computeAllDates({ project, nodes });
    for (const node of nodes) {
      const pics = toPicArray(node.pic);
      if (!pics.length) continue;
      if (SILENT.has(node.status)) continue;

      const due = dates[node.node_id]?.due;
      if (!due) continue;

      const dy = due.getFullYear();
      const dm = due.getMonth() + 1;
      const dd = due.getDate();
      const dueUtc = Date.UTC(dy, dm - 1, dd);
      const dueIso = `${dy}-${String(dm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      const diffDays = Math.round((dueUtc - today.utc) / 86400000);
      const dueLabel = fmtDMY(dy, dm, dd);

      // Nhiều PIC/1 bước -> mỗi người 1 item riêng. dedup_key kèm norm(pic) để
      // mỗi người được nhắc độc lập (không đè nhau ở bảng sent_reminders).
      for (const pic of pics) {
        const base = { project, node, pic, dueLabel };

        // Việc mới giao (assigned) KHÔNG quét ở đây nữa — đã chuyển sang gửi ngay
        // khi phân PIC qua notifyAssignment(). Vòng quét chỉ lo due_soon/overdue.

        // Trước hạn ~24h: hạn rơi đúng vào ngày mai.
        if (diffDays === 1) {
          items.push({ ...base, kind: 'due_soon', dedup_key: `${dueIso}|${norm(pic)}` });
        }

        // Quá hạn: nhắc mỗi ngày (dedup theo ngày hôm nay + người).
        if (diffDays < 0) {
          items.push({ ...base, kind: 'overdue', dedup_key: `${today.iso}|${norm(pic)}`, lateDays: -diffDays });
        }
      }
    }
  }
  return { items, today };
}

// Bỏ các item đã gửi rồi (đọc toàn bộ sent_reminders — bảng nhỏ theo quy mô đội).
async function filterUnsent(items) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('sent_reminders')
    .select('project_id,node_id,kind,dedup_key');
  if (error) {
    const e = new Error(
      'Không đọc được bảng sent_reminders (đã chạy sql/reminders.sql chưa?): ' + error.message,
    );
    e.code = 'NO_TABLE';
    throw e;
  }
  const seen = new Set(
    (data || []).map((r) => `${r.project_id}|${r.node_id}|${r.kind}|${r.dedup_key}`),
  );
  // "Lần đầu" chỉ tính theo các loại mà VÒNG QUÉT tạo ra (due_soon/overdue).
  // KHÔNG tính 'assigned' (giờ do sự kiện phân PIC ghi vào bất cứ lúc nào) và
  // KHÔNG tính dòng báo cáo nhóm (daily_report) — nếu không sẽ hiểu nhầm đã qua
  // lần đầu và gửi ồ ạt việc quá hạn cũ.
  const PIC_KINDS = new Set(['due_soon', 'overdue']);
  const firstRun = (data || []).filter((r) => PIC_KINDS.has(r.kind)).length === 0;
  const remaining = items.filter(
    (it) => !seen.has(`${it.project.id}|${it.node.node_id}|${it.kind}|${it.dedup_key}`),
  );
  return { remaining, firstRun };
}

async function recordSent(items) {
  if (!items.length) return;
  const supabase = getSupabaseClient();
  const rows = items.map((it) => ({
    project_id: it.project.id,
    node_id: it.node.node_id,
    kind: it.kind,
    dedup_key: it.dedup_key,
    pic: it.pic,
    email: it.email || null,
  }));
  const { error } = await supabase
    .from('sent_reminders')
    .upsert(rows, { onConflict: 'project_id,node_id,kind,dedup_key', ignoreDuplicates: true });
  if (error) throw error;
}

function composeMessage(list) {
  const byKind = { assigned: [], due_soon: [], overdue: [] };
  for (const it of list) byKind[it.kind].push(it);

  // Mọi dòng đều kèm TÊN dự án để PIC biết ngay việc thuộc dự án nào, và ngay
  // dưới là link mở thẳng dự án đó.
  const line = (it) =>
    `• [${it.project.code}] ${it.project.name || ''} – ${it.node.node_id} ${it.node.node_name || ''} (hạn ${it.dueLabel})`;
  const out = ['📋 Nhắc việc – Feelex QLDA', ''];
  const pushStep = (text, it) => {
    out.push(text);
    out.push(`  ${projectUrl(it.project)}`);
  };

  if (byKind.assigned.length) {
    out.push('🔔 Việc mới được giao:');
    byKind.assigned.forEach((it) => pushStep(line(it), it));
    out.push('');
  }
  if (byKind.due_soon.length) {
    out.push('⏰ Sắp đến hạn (trong 24h):');
    byKind.due_soon.forEach((it) => pushStep(line(it), it));
    out.push('');
  }
  if (byKind.overdue.length) {
    out.push('⚠️ Việc quá hạn:');
    byKind.overdue.forEach((it) =>
      pushStep(
        `• [${it.project.code}] ${it.project.name || ''} – ${it.node.node_id} ${it.node.node_name || ''} (quá hạn ${it.lateDays} ngày, hạn ${it.dueLabel})`,
        it,
      ),
    );
    out.push('');
  }
  out.push('Nhắn cập nhật cho tôi lúc xong hoặc cập nhật tiến độ trên Feelex QLDA - https://qlda-rd.feelex.vn. Cảm ơn bạn!');
  return out.join('\n');
}

// Gửi 1 tin cho 1 người theo liên hệ tốt nhất: open_id trước (tới được cả người
// không email trên Lark), lỗi thì fallback email. Trả về data Lark ({code,msg}).
async function sendToContact(contact, text) {
  if (contact?.open_id) {
    const r = await sendTextByOpenId(contact.open_id, text);
    if (r && r.code === 0) return r;
    if (contact.email) return sendTextByEmail(contact.email, text); // open_id lỗi -> thử email
    return r;
  }
  if (contact?.email) return sendTextByEmail(contact.email, text);
  return { code: -1, msg: 'no-contact' };
}

// Chạy 1 lượt nhắc. options:
//   dryRun=true -> chỉ tính & trả nội dung, KHÔNG gửi, KHÔNG ghi DB.
async function runReminders({ dryRun = false } = {}) {
  const contactMap = await loadPicContactMap();
  const { items } = await computeReminderItems();

  let remaining = items;
  let firstRun = false;
  try {
    const filtered = await filterUnsent(items);
    remaining = filtered.remaining;
    firstRun = filtered.firstRun;
  } catch (err) {
    if (err.code === 'NO_TABLE') {
      // dryRun vẫn xem trước được dù chưa tạo bảng; chạy thật thì dừng có báo lỗi.
      if (!dryRun) return { ok: false, error: err.message };
    } else {
      throw err;
    }
  }

  // Gắn liên hệ (open_id/email) cho từng item; tách nhóm gửi được / không liên hệ.
  for (const it of remaining) {
    it.contact = contactMap.get(norm(it.pic)) || null;
    it.email = it.contact?.email || null; // để recordSent lưu lại
  }
  const sendable = remaining.filter((it) => it.contact && (it.contact.open_id || it.contact.email));
  const noContact = remaining.filter((it) => !(it.contact && (it.contact.open_id || it.contact.email)));
  const missingPics = [...new Set(noContact.map((it) => it.pic))];

  // Lần chạy ĐẦU TIÊN (bảng rỗng): ghi nhận hiện trạng, KHÔNG gửi để tránh spam
  // hàng loạt việc cũ. Từ lần sau chỉ những thay đổi mới mới được gửi.
  if (firstRun && !dryRun) {
    await recordSent(sendable);
    return {
      ok: true,
      firstRun: true,
      backfilled: sendable.length,
      sent: 0,
      noContactItems: noContact.length,
      missingPics,
      note: 'Lần đầu: đã ghi nhận hiện trạng, chưa gửi tin nào.',
    };
  }

  // Gộp theo người (khóa = open_id || email) -> 1 tin/người.
  const byPerson = new Map();
  for (const it of sendable) {
    const key = it.contact.open_id || it.contact.email;
    if (!byPerson.has(key)) byPerson.set(key, { contact: it.contact, list: [] });
    byPerson.get(key).list.push(it);
  }

  const preview = [];
  const sentItems = [];
  for (const [key, { contact, list }] of byPerson) {
    const text = composeMessage(list);
    if (dryRun) {
      preview.push({ to: key, count: list.length, text });
      continue;
    }
    const res = await sendToContact(contact, text);
    if (res && res.code === 0) sentItems.push(...list);
    else preview.push({ to: key, count: list.length, ok: false, err: res?.msg });
  }

  if (!dryRun) await recordSent(sentItems);

  return {
    ok: true,
    dryRun,
    people: byPerson.size,
    sent: dryRun ? 0 : sentItems.length,
    noContactItems: noContact.length,
    missingPics,
    preview: dryRun ? preview : preview.length ? preview : undefined,
  };
}

// Gửi NGAY 1 thông báo "việc mới được giao" cho đúng 1 bước khi PIC vừa được
// phân (gọi từ luồng sửa node). Dedupe qua sent_reminders theo (project/node/
// assigned/norm(pic)) -> đổi sang PIC khác thì gửi cho người mới; giữ nguyên PIC
// thì không gửi lại. Trả { ok, reason?, ... }. Không ném lỗi ra ngoài để không
// làm hỏng thao tác lưu — luồng gọi vẫn nên .catch() cho chắc.
async function notifyAssignment(projectId, nodeId) {
  if (!remindersEnabled || !isLarkConfigured) {
    return { ok: false, reason: 'disabled' };
  }

  const { project, nodes } = await getProjectDetail(projectId);
  const node = (nodes || []).find((n) => n.node_id === nodeId);
  if (!node) return { ok: false, reason: 'not_found' };
  const pics = toPicArray(node.pic);
  if (!pics.length) return { ok: false, reason: 'no_pic' };
  if (SILENT.has(node.status)) return { ok: false, reason: 'silent_status' };

  // Mỗi PIC (có liên hệ, không phải nhãn vai trò/người ngoài danh bạ) -> 1 tin.
  const contactMap = await loadPicContactMap();
  const dates = computeAllDates({ project, nodes });
  const due = dates[node.node_id]?.due;
  const dueLabel = due
    ? fmtDMY(due.getFullYear(), due.getMonth() + 1, due.getDate())
    : '—';

  const items = [];
  for (const pic of pics) {
    const contact = contactMap.get(norm(pic));
    if (!contact || (!contact.open_id && !contact.email)) continue;
    items.push({
      project, node, pic, dueLabel, kind: 'assigned', dedup_key: norm(pic),
      contact, email: contact.email || null,
    });
  }
  if (!items.length) return { ok: false, reason: 'no_contact', pics };

  // Bỏ các PIC đã báo trước đó ở bước này (nếu bảng tồn tại).
  let remaining = items;
  try {
    const filtered = await filterUnsent(items);
    remaining = filtered.remaining;
  } catch (err) {
    if (err.code !== 'NO_TABLE') throw err;
  }
  if (!remaining.length) return { ok: false, reason: 'already_sent' };

  const sentItems = [];
  for (const it of remaining) {
    const res = await sendToContact(it.contact, composeMessage([it]));
    if (res && res.code === 0) sentItems.push(it);
  }
  if (sentItems.length) {
    try {
      await recordSent(sentItems);
    } catch (_e) {
      // gửi được là chính; ghi dedupe lỗi (vd chưa có bảng) thì bỏ qua.
    }
    return { ok: true, sent: sentItems.length };
  }
  return { ok: false, reason: 'send_failed' };
}

// Gửi TIN GIAO VIỆC khi vừa TẠO DỰ ÁN mới: gom theo người nhận -> 1 tin tóm tắt/
// người liệt kê các bước họ phụ trách. Nhãn "Trưởng phòng X" -> gửi trưởng phòng
// thật; PIC là người thật -> gửi thẳng. Dedupe qua sent_reminders (kind 'assigned',
// dedup_key = norm(pic)) để không trùng với notifyAssignment sau này.
// Không ném lỗi ra ngoài (chạy nền sau khi tạo dự án).
async function notifyNewProjectAssignments(projectId) {
  if (!remindersEnabled || !isLarkConfigured) return { ok: false, reason: 'disabled' };

  const { project, nodes } = await getProjectDetail(projectId);
  const contactMap = await loadPicContactMap();
  const leaderMap = await loadLeaderContactMap(contactMap);
  const dates = computeAllDates({ project, nodes });

  const items = [];
  for (const node of nodes) {
    if (SILENT.has(node.status)) continue;
    const due = dates[node.node_id]?.due;
    const dueLabel = due ? fmtDMY(due.getFullYear(), due.getMonth() + 1, due.getDate()) : '—';
    for (const pic of toPicArray(node.pic)) {
      const contact = resolveAssignContact(pic, contactMap, leaderMap);
      if (!contact) continue;
      items.push({
        project,
        node,
        pic,
        dueLabel,
        kind: 'assigned',
        dedup_key: norm(pic),
        contact,
        email: contact.email || null,
      });
    }
  }
  if (!items.length) return { ok: true, sent: 0, note: 'no_contact_pic' };

  // Bỏ các bước đã báo trước đó (nếu bảng tồn tại).
  let remaining = items;
  try {
    const filtered = await filterUnsent(items);
    remaining = filtered.remaining;
  } catch (err) {
    if (err.code !== 'NO_TABLE') throw err;
  }
  if (!remaining.length) return { ok: true, sent: 0, note: 'already_sent' };

  // Gom theo người nhận -> 1 tin/người.
  const byPerson = new Map();
  for (const it of remaining) {
    const key = it.contact.open_id || it.contact.email;
    if (!byPerson.has(key)) byPerson.set(key, { contact: it.contact, list: [] });
    byPerson.get(key).list.push(it);
  }

  const sentItems = [];
  for (const [, { contact, list }] of byPerson) {
    const res = await sendToContact(contact, composeMessage(list));
    if (res && res.code === 0) sentItems.push(...list);
  }
  try {
    await recordSent(sentItems);
  } catch (_e) {
    // bảng chưa có -> đã gửi là chính, bỏ qua ghi dedupe.
  }

  return { ok: true, people: byPerson.size, sent: sentItems.length };
}

// Nội dung tin "việc kế tiếp sẵn sàng" (bước trước vừa xong -> bước sau mở khoá).
function composeStartedMessage(list) {
  const line = (it) =>
    `• [${it.project.code}] ${it.project.name || ''} – ${it.node.node_id} ${it.node.node_name || ''} (hạn ${it.dueLabel})`;
  const out = ['✅ Bước trước đã xong – việc kế tiếp sẵn sàng để làm:', ''];
  list.forEach((it) => {
    out.push(line(it));
    out.push(`  ${projectUrl(it.project)}`);
  });
  out.push('');
  out.push('Nhắn cập nhật cho tôi lúc xong hoặc cập nhật tiến độ trên Feelex QLDA - https://qlda-rd.feelex.vn. Cảm ơn bạn!');
  return out.join('\n');
}

// Gửi NGAY thông báo khi bước trước hoàn thành -> các bước kế tiếp chuyển sang
// 'Đang làm'. Mỗi bước báo cho: (1) PIC của bước, (2) TRƯỞNG PHÒNG của bước.
// startedNodeIds = danh sách node vừa được startReadySuccessors() mở khoá.
// Dedupe qua sent_reminders (kind 'started', dedup_key = liên hệ người nhận) để
// không gửi lại. Gom theo người -> 1 tin/người. Không ném lỗi ra ngoài (chạy nền).
async function notifyStepsStarted(projectId, startedNodeIds) {
  if (!remindersEnabled || !isLarkConfigured) return { ok: false, reason: 'disabled' };
  const ids = (startedNodeIds || []).filter(Boolean);
  if (!ids.length) return { ok: false, reason: 'no_nodes' };

  const { project, nodes } = await getProjectDetail(projectId);
  const contactMap = await loadPicContactMap();
  const leaderMap = await loadLeaderContactMap(contactMap);
  const dates = computeAllDates({ project, nodes });

  const items = [];
  for (const nid of ids) {
    const node = (nodes || []).find((n) => n.node_id === nid);
    if (!node) continue;
    if (SILENT.has(node.status)) continue; // an toàn: chỉ bước đang mở
    const due = dates[node.node_id]?.due;
    const dueLabel = due ? fmtDMY(due.getFullYear(), due.getMonth() + 1, due.getDate()) : '—';

    // Người nhận cho bước kế tiếp: CHỈ PIC của bước (không báo trưởng phòng bước
    // sau — trưởng phòng chỉ được báo cho bước VỪA XONG, xem notifyStepCompleted).
    const recipByKey = new Map();
    const addRecip = (contact) => {
      if (!contact || !(contact.open_id || contact.email)) return;
      recipByKey.set(contact.open_id || contact.email, contact);
    };
    for (const pic of toPicArray(node.pic)) {
      addRecip(resolveAssignContact(pic, contactMap, leaderMap));
    }

    for (const [key, contact] of recipByKey) {
      items.push({
        project, node, pic: picText(node.pic),
        dueLabel, kind: 'started', dedup_key: norm(key),
        contact, email: contact.email || null,
      });
    }
  }
  if (!items.length) return { ok: true, sent: 0, note: 'no_contact' };

  // Bỏ các (bước, người) đã báo trước đó (nếu bảng tồn tại).
  let remaining = items;
  try {
    const filtered = await filterUnsent(items);
    remaining = filtered.remaining;
  } catch (err) {
    if (err.code !== 'NO_TABLE') throw err;
  }
  if (!remaining.length) return { ok: true, sent: 0, note: 'already_sent' };

  // Gom theo người nhận -> 1 tin/người.
  const byPerson = new Map();
  for (const it of remaining) {
    const key = it.contact.open_id || it.contact.email;
    if (!byPerson.has(key)) byPerson.set(key, { contact: it.contact, list: [] });
    byPerson.get(key).list.push(it);
  }

  const sentItems = [];
  for (const [, { contact, list }] of byPerson) {
    const res = await sendToContact(contact, composeStartedMessage(list));
    if (res && res.code === 0) sentItems.push(...list);
  }
  try {
    await recordSent(sentItems);
  } catch (_e) {
    // bảng chưa có -> đã gửi là chính, bỏ qua ghi dedupe.
  }

  return { ok: true, people: byPerson.size, sent: sentItems.length };
}

// ---- Đổi ngày dự kiến -------------------------------------------------------
// "Ngày dự kiến" (cột Dự kiến trên web) = due của computeAllDates — tính động,
// KHÔNG lưu DB. Sửa 1 bước (số ngày / sau bước / ngày thực tế / bỏ qua) có thể
// dời ngày của NHIỀU bước phía sau, mỗi bước một PIC. Nên cách duy nhất biết ai
// bị ảnh hưởng là: chụp ảnh ngày dự kiến TRƯỚC khi sửa, tính lại SAU khi sửa rồi
// so sánh toàn dự án.

// Các trường khi sửa có thể làm dời ngày dự kiến. 'pic'/'notes' thì không.
const DATE_FIELDS = ['duration', 'after', 'actual_date', 'status'];

function affectsDueDates(payload) {
  return DATE_FIELDS.some((f) => payload && payload[f] !== undefined);
}

// Chụp ảnh ngày dự kiến hiện tại của mọi bước -> { node_id: 'YYYY-MM-DD' }.
// Gọi TRƯỚC khi sửa; truyền kết quả vào notifyDueDateChanges() sau khi sửa xong.
// Lỗi thì trả null (không có ảnh -> bỏ qua báo đổi ngày, không phá luồng lưu).
async function snapshotDueDates(projectId) {
  try {
    const { project, nodes } = await getProjectDetail(projectId);
    const dates = computeAllDates({ project, nodes });
    const map = {};
    for (const n of nodes || []) {
      const due = dates[n.node_id]?.due;
      if (due) map[n.node_id] = isoLocal(due);
    }
    return map;
  } catch (_e) {
    return null;
  }
}

function composeDateChangedMessage(list) {
  const out = ['📅 Ngày dự kiến của việc bạn phụ trách vừa thay đổi:', ''];
  list.forEach((it) => {
    out.push(
      `• [${it.project.code}] ${it.project.name || ''} – ${it.node.node_id} ${it.node.node_name || ''} (dự kiến ${it.oldLabel} → ${it.dueLabel})`,
    );
    out.push(`  ${projectUrl(it.project)}`);
  });
  out.push('');
  out.push('Nhắn cập nhật cho tôi lúc xong hoặc cập nhật tiến độ trên Feelex QLDA - https://qlda-rd.feelex.vn. Cảm ơn bạn!');
  return out.join('\n');
}

// So ảnh chụp TRƯỚC (before) với ngày dự kiến HIỆN TẠI -> bước nào dời ngày thì
// báo PIC của chính bước đó (Lark DM). Bỏ qua bước đã 'Đã xong'/'Bỏ qua' (ngày
// đổi cũng không còn ý nghĩa hành động) và bước mới xuất hiện (không có ảnh cũ).
// Dedupe qua sent_reminders (kind 'date_changed', dedup_key = 'cũ>mới') -> cùng
// một lần dời chỉ báo 1 lần, nhưng dời tiếp sang ngày khác thì vẫn báo.
// Gom theo người -> 1 tin/người. Không ném lỗi ra ngoài (chạy nền).
async function notifyDueDateChanges(projectId, before) {
  if (!remindersEnabled || !isLarkConfigured) return { ok: false, reason: 'disabled' };
  if (!before || !Object.keys(before).length) return { ok: false, reason: 'no_snapshot' };

  const { project, nodes } = await getProjectDetail(projectId);
  const dates = computeAllDates({ project, nodes });
  const contactMap = await loadPicContactMap();
  const leaderMap = await loadLeaderContactMap(contactMap);

  const items = [];
  for (const node of nodes || []) {
    if (SILENT.has(node.status)) continue;
    const pics = toPicArray(node.pic);
    if (!pics.length) continue;

    const due = dates[node.node_id]?.due;
    if (!due) continue;
    const newIso = isoLocal(due);
    const oldIso = before[node.node_id];
    if (!oldIso || oldIso === newIso) continue; // bước mới, hoặc không dời

    for (const pic of pics) {
      const contact = resolveAssignContact(pic, contactMap, leaderMap);
      if (!contact) continue;
      items.push({
        project, node, pic,
        oldLabel: fmtIso(oldIso),
        dueLabel: fmtDate(due),
        kind: 'date_changed',
        dedup_key: `${oldIso}>${newIso}|${norm(pic)}`,
        contact,
        email: contact.email || null,
      });
    }
  }
  if (!items.length) return { ok: true, sent: 0, note: 'no_change' };

  let remaining = items;
  try {
    const filtered = await filterUnsent(items);
    remaining = filtered.remaining;
  } catch (err) {
    if (err.code !== 'NO_TABLE') throw err;
  }
  if (!remaining.length) return { ok: true, sent: 0, note: 'already_sent' };

  const byPerson = new Map();
  for (const it of remaining) {
    const key = it.contact.open_id || it.contact.email;
    if (!byPerson.has(key)) byPerson.set(key, { contact: it.contact, list: [] });
    byPerson.get(key).list.push(it);
  }

  const sentItems = [];
  for (const [, { contact, list }] of byPerson) {
    const res = await sendToContact(contact, composeDateChangedMessage(list));
    if (res && res.code === 0) sentItems.push(...list);
  }
  try {
    await recordSent(sentItems);
  } catch (_e) {
    // bảng chưa có -> đã gửi là chính, bỏ qua ghi dedupe.
  }

  return { ok: true, people: byPerson.size, sent: sentItems.length };
}

function composeCompletedMessage(project, node, statusLabel, pic) {
  const verb = statusLabel === 'Bỏ qua' ? 'đã được BỎ QUA' : 'đã HOÀN TẤT';
  const who = pic && String(pic).trim() ? ` (PIC: ${String(pic).trim()})` : '';
  return [
    `✅ Bước ${verb}:`,
    '',
    `• [${project.code}] ${project.name || ''} – ${node.node_id} ${node.node_name || ''}${who}`,
    `  ${projectUrl(project)}`,
    '',
    'Xem chi tiết trên Feelex QLDA - https://qlda-rd.feelex.vn. Cảm ơn bạn!',
  ].join('\n');
}

// Gửi NGAY cho TRƯỞNG PHÒNG của chính bước vừa 'Đã xong'/'Bỏ qua' để họ nắm bước
// của phòng mình đã kết thúc. Chỉ gửi trưởng phòng (không gửi PIC bước này).
// Nếu PIC bước này chính là trưởng phòng thì vẫn nhận (họ là trưởng phòng).
// Ngoài ra gửi thêm cho NGƯỜI THEO DÕI khai trong STEP_DONE_WATCHER_OPEN_IDS —
// họ nhận mọi bước xong/bỏ qua, kể cả bước không có dept hoặc phòng chưa có trưởng phòng.
// Dedupe qua sent_reminders (kind 'completed', dedup_key = liên hệ người nhận); người
// theo dõi trùng trưởng phòng thì chỉ nhận 1 tin.
// Không ném lỗi ra ngoài (chạy nền).
async function notifyStepCompleted(projectId, nodeId, statusLabel) {
  if (!remindersEnabled || !isLarkConfigured) return { ok: false, reason: 'disabled' };

  const { project, nodes } = await getProjectDetail(projectId);
  const node = (nodes || []).find((n) => n.node_id === nodeId);
  if (!node) return { ok: false, reason: 'not_found' };

  const dept = (node.dept || '').trim();
  const recipients = [];
  const seen = new Set(); // theo dedup_key -> tránh gửi 2 lần cho cùng 1 người

  if (dept) {
    const contactMap = await loadPicContactMap();
    const leaderMap = await loadLeaderContactMap(contactMap);
    const leader = leaderMap.get(dept);
    if (leader && (leader.open_id || leader.email)) {
      recipients.push(leader);
      seen.add(norm(leader.open_id || leader.email));
    }
  }

  for (const openId of stepDoneWatcherOpenIds) {
    const key = norm(openId);
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({ open_id: openId, email: null });
  }

  if (!recipients.length) return { ok: false, reason: 'no_recipient', dept };

  const items = recipients.map((contact) => ({
    project, node, pic: picText(node.pic),
    dueLabel: '—', kind: 'completed',
    dedup_key: norm(contact.open_id || contact.email),
    contact, email: contact.email || null,
  }));

  // Ai đã được báo về bước này rồi thì bỏ qua (nếu bảng tồn tại).
  let remaining = items;
  try {
    const filtered = await filterUnsent(items);
    remaining = filtered.remaining;
  } catch (err) {
    if (err.code !== 'NO_TABLE') throw err;
  }
  if (!remaining.length) return { ok: true, sent: 0, note: 'already_sent' };

  const text = composeCompletedMessage(project, node, statusLabel, picText(node.pic));
  const sent = [];
  const failed = [];
  for (const it of remaining) {
    const res = await sendToContact(it.contact, text);
    if (res && res.code === 0) sent.push(it);
    else failed.push({ dedup_key: it.dedup_key, err: res?.msg });
  }

  if (sent.length) {
    try {
      await recordSent(sent);
    } catch (_e) {
      // gửi được là chính; ghi dedupe lỗi thì bỏ qua.
    }
  }
  if (!sent.length) return { ok: false, reason: 'send_failed', failed };
  return { ok: true, sent: sent.length, failed: failed.length ? failed : undefined };
}

module.exports = {
  runReminders,
  notifyAssignment,
  notifyNewProjectAssignments,
  notifyStepsStarted,
  notifyStepCompleted,
  snapshotDueDates,
  notifyDueDateChanges,
  affectsDueDates,
};
