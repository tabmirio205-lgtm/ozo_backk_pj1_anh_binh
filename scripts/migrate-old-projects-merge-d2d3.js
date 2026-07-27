/*
 * Migration: đưa DỰ ÁN CŨ về đúng bố cục nhánh D của dự án TẠO MỚI (WORKFLOW_NODES),
 * tức GỘP D2 + D3 và dồn mã.
 *
 * Bối cảnh: migrate-merge-d2d3.js trước đây chỉ đổi master + đóng băng tên riêng cho
 * dự án cũ, KHÔNG đổi cấu trúc. Nên dự án cũ vẫn D1..D5, còn dự án mới là D1..D4.
 *
 *   CŨ (D1..D5)                                  MỚI (D1..D4, = WORKFLOW_NODES)
 *   D1 Đánh giá khả thi công bố    (sau B8)   ->  D1 Đánh giá khả thi công bố   (sau B8)
 *   D2 Đánh giá khả thi sản xuất   (sau B7)   -\
 *   D3 Pha mẫu và sửa mẫu          (sau D2)   -/> D2 Pha mẫu & sửa mẫu          (sau B7)
 *   D4 Phê duyệt NCC gia công      (sau D3)   ->  D3 Phê duyệt NCC gia công     (sau D2)
 *   D5 Theo dõi độ ổn định NM      (sau D4)   ->  D4 Theo dõi độ ổn định NM     (sau D3)
 *   E1 Soạn hồ sơ công bố          (sau D4)   ->  E1 Soạn hồ sơ công bố         (sau D3)
 *
 * Gộp D2+D3 thành 1 bước như thế nào:
 *   - name    : 'Pha mẫu & sửa mẫu' (tên chuẩn mới)
 *   - dept    : lấy của D3 (nội dung pha mẫu), rỗng thì lấy của D2
 *   - pic     : hợp 2 danh sách (bỏ trùng)
 *   - status  : có 'Đang làm' -> 'Đang làm'; còn 'Chưa làm' -> 'Chưa làm';
 *               cả hai đã kết thúc -> 'Bỏ qua' nếu cả hai bỏ qua, ngược lại 'Đã xong'
 *   - duration: 'Bỏ qua' -> cộng thẳng 2 số (planner tính 0 ngày nên lịch không đổi);
 *               ngược lại cộng số ngày CÓ HIỆU LỰC (phần đang 'Bỏ qua' tính 0)
 *               -> ngày dự kiến của các bước phía sau KHÔNG bị xê dịch.
 *   - actual_date: ngày muộn hơn trong 2 bước (chỉ giữ khi bước gộp đã kết thúc)
 *   - notes / attachments: gộp cả hai (ghi chú của D2 kèm nhãn để biết nguồn)
 *   - after   : giữ `after` của D2 cũ (thường ['B7'])
 *   - planned_date: lấy mốc của D3 cũ (thời điểm kết thúc cặp D2+D3) -> baseline không đổi
 *
 * Ngoài ra: remap cột `after` của MỌI node (D3->D2, D4->D3, D5->D4) và đổi node_id
 * D4->D3, D5->D4; sent_reminders remap theo (giữ dedup nhắc việc).
 *
 * An toàn: KHÔNG cờ = DRY RUN (chỉ in + ghi file backup). Thêm `--apply` để ghi thật.
 *          Backup TOÀN BỘ node nhánh D của mọi dự án ra JSON trước khi ghi.
 * Idempotent: dự án đã đúng bố cục mới (không còn D5) sẽ bỏ qua.
 *
 * Chạy:
 *   node backend/scripts/migrate-old-projects-merge-d2d3.js          # xem trước
 *   node backend/scripts/migrate-old-projects-merge-d2d3.js --apply  # thực thi
 */

require('../src/config/env'); // nạp .env (dotenv)
const fs = require('node:fs');
const path = require('node:path');
const { getSupabaseClient } = require('../src/config/supabaseClient');
const { WORKFLOW_NODES } = require('../src/constants/workflowNodes');
const { computeAllDates, isoLocal } = require('../src/utils/datePlanner');

const APPLY = process.argv.includes('--apply');
const BACKUP_FILE = path.join(__dirname, 'backup-branch-d.json');

const MERGED_NAME = 'Pha mẫu & sửa mẫu'; // = WORKFLOW_NODES D2
const RENAME = { D4: 'D3', D5: 'D4' }; // dồn mã sau khi gộp
const AFTER_MAP = { D3: 'D2', D4: 'D3', D5: 'D4' }; // remap phụ thuộc (D2 giữ nguyên)

const DONE = 'Đã xong';
const SKIP = 'Bỏ qua';
const DOING = 'Đang làm';
const TODO = 'Chưa làm';

// Baseline "ngày dự kiến": tính từ start_date + duration + after, BỎ QUA actual_date
// (giống projectService.baselinePlannedDates).
function baselinePlannedDates(project, nodes) {
  const dates = computeAllDates({
    project,
    nodes: nodes.map((n) => ({
      node_id: n.node_id,
      after: n.after || [],
      duration: n.duration,
      status: n.status,
      actual_date: null,
    })),
  });
  const out = {};
  for (const n of nodes) out[n.node_id] = dates[n.node_id] ? isoLocal(dates[n.node_id].due) : null;
  return out;
}

const sameArr = (a, b) =>
  (a || []).length === (b || []).length && (a || []).every((v, i) => v === (b || [])[i]);

function remapAfter(after) {
  const out = [];
  for (const dep of after || []) {
    const v = AFTER_MAP[dep] || dep;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function mergeStatus(a, b) {
  const s = [a, b];
  if (s.includes(DOING)) return DOING;
  if (s.includes(TODO)) return TODO;
  if (s.every((x) => x === SKIP)) return SKIP;
  return DONE; // ít nhất một bước 'Đã xong', bước kia đã kết thúc
}

// Gộp 2 dòng D2 + D3 cũ thành nội dung của bước D2 mới.
function mergeNodes(d2, d3) {
  const status = mergeStatus(d2.status, d3.status);
  const eff = (n) => (n.status === SKIP ? 0 : n.duration || 0);
  const duration = status === SKIP ? (d2.duration || 0) + (d3.duration || 0) : eff(d2) + eff(d3);

  const pic = [];
  for (const p of [...(d3.pic || []), ...(d2.pic || [])]) if (p && !pic.includes(p)) pic.push(p);

  const notes = [
    (d3.notes || '').trim(),
    (d2.notes || '').trim() ? `[${d2.name || 'Đánh giá khả thi sản xuất'}] ${(d2.notes || '').trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const files = [...(Array.isArray(d3.attachments) ? d3.attachments : []), ...(Array.isArray(d2.attachments) ? d2.attachments : [])];

  const dates = [d2.actual_date, d3.actual_date].filter(Boolean).sort();
  const actual_date = status === DONE || status === SKIP ? dates[dates.length - 1] || null : null;

  return {
    name: MERGED_NAME,
    dept: d3.dept || d2.dept || null,
    pic,
    status,
    duration,
    actual_date,
    notes,
    attachments: files,
    after: d2.after || [],
    planned_date: d3.planned_date ?? d2.planned_date ?? null,
  };
}

async function migrateProject(supabase, project, nodes, plannedSupported) {
  const old = Object.fromEntries(nodes.map((n) => [n.node_id, n]));
  if (!old.D5) return { skipped: 'không có D5 (đã đúng bố cục mới?)' };
  for (const id of ['D2', 'D3', 'D4']) if (!old[id]) return { skipped: `thiếu node ${id}` };

  const merged = mergeNodes(old.D2, old.D3);

  // Dựng tập node SAU migration (để tính baseline dự phòng khi D3 cũ chưa có planned_date).
  const nextNodes = nodes
    .filter((n) => n.node_id !== 'D3')
    .map((n) =>
      n.node_id === 'D2'
        ? { ...n, ...merged }
        : { ...n, node_id: RENAME[n.node_id] || n.node_id, after: remapAfter(n.after) },
    );
  if (plannedSupported && merged.planned_date == null) {
    merged.planned_date = baselinePlannedDates(project, nextNodes).D2 ?? null;
  }
  if (!plannedSupported) delete merged.planned_date;

  // Các node KHÁC chỉ đổi `after` (và node_id với D4/D5) — ngày dự kiến giữ nguyên.
  const rewire = [];
  for (const n of nodes) {
    if (n.node_id === 'D2' || n.node_id === 'D3') continue;
    const payload = {};
    const nextAfter = remapAfter(n.after);
    if (!sameArr(n.after, nextAfter)) payload.after = nextAfter;
    if (RENAME[n.node_id]) payload.node_id = RENAME[n.node_id];
    if (Object.keys(payload).length) rewire.push({ oldId: n.node_id, payload });
  }

  if (APPLY) {
    // 1) D2 <- nội dung gộp.
    let r = await supabase
      .from('project_nodes')
      .update(merged)
      .eq('project_id', project.id)
      .eq('node_id', 'D2');
    if (r.error) throw new Error(`P${project.id} gộp D2: ${r.error.message}`);

    // 2) Xoá D3 cũ (đã gộp vào D2).
    r = await supabase.from('project_nodes').delete().eq('project_id', project.id).eq('node_id', 'D3');
    if (r.error) throw new Error(`P${project.id} xoá D3: ${r.error.message}`);

    // 3) Đổi mã theo thứ tự D4->D3 rồi D5->D4 (luôn ghi vào ô vừa trống, không đụng khoá).
    const order = ['D4', 'D5', ...rewire.map((x) => x.oldId).filter((id) => id !== 'D4' && id !== 'D5')];
    for (const oldId of order) {
      const item = rewire.find((x) => x.oldId === oldId);
      if (!item) continue;
      r = await supabase
        .from('project_nodes')
        .update(item.payload)
        .eq('project_id', project.id)
        .eq('node_id', oldId);
      if (r.error) throw new Error(`P${project.id} ${oldId}: ${r.error.message}`);
    }

    // 4) sent_reminders: D3 cũ bỏ đi, D4->D3, D5->D4 (giữ dedup nhắc việc).
    r = await supabase.from('sent_reminders').delete().eq('project_id', project.id).eq('node_id', 'D3');
    if (r.error && r.error.code !== '42P01') throw new Error(`P${project.id} reminders D3: ${r.error.message}`);
    for (const [from, to] of [['D4', 'D3'], ['D5', 'D4']]) {
      r = await supabase
        .from('sent_reminders')
        .update({ node_id: to })
        .eq('project_id', project.id)
        .eq('node_id', from);
      if (r.error && r.error.code !== '42P01') throw new Error(`P${project.id} reminders ${from}->${to}: ${r.error.message}`);
    }
  }

  return {
    done: true,
    detail:
      `D2 gộp: "${old.D2.status}"+"${old.D3.status}" -> "${merged.status}", ` +
      `${old.D2.duration}n+${old.D3.duration}n -> ${merged.duration}n, ` +
      `dept ${merged.dept || '-'}, pic [${merged.pic.join('|') || '-'}]` +
      (merged.actual_date ? `, ngày thực tế ${merged.actual_date}` : '') +
      ` | D4->D3, D5->D4 | after đổi ở [${rewire.filter((x) => x.payload.after).map((x) => x.oldId).join(',') || '-'}]`,
  };
}

async function syncMasterNodes(supabase) {
  const rows = WORKFLOW_NODES.filter((n) => n.code[0] === 'D' || n.code === 'E1').map((n) => ({
    code: n.code,
    stage: n.stage,
    name: n.name,
    dept: n.dept,
    default_duration: n.defaultDuration,
    default_after: n.defaultAfter,
  }));
  if (APPLY) {
    const { error } = await supabase.from('master_nodes').upsert(rows, { onConflict: 'code' });
    if (error) throw new Error(`master_nodes: ${error.message}`);
    const del = await supabase.from('master_nodes').delete().eq('code', 'D5');
    if (del.error) throw new Error(`master_nodes xoá D5: ${del.error.message}`);
  }
  return rows.map((r) => `  ${r.code} -> "${r.name}" (${r.dept || '-'}, ${r.default_duration}n, sau [${(r.default_after || []).join(',')}])`);
}

async function main() {
  const supabase = getSupabaseClient();
  console.log(`\n=== Migration gộp D2+D3 cho DỰ ÁN CŨ === (${APPLY ? 'APPLY - GHI DB' : 'DRY RUN - chỉ xem'})\n`);

  const { data: projects, error: pErr } = await supabase
    .from('projects')
    .select('id,code,name,start_date')
    .order('code', { ascending: true });
  if (pErr) throw pErr;
  const codeById = new Map((projects || []).map((p) => [p.id, p.code]));

  const { data: allNodes, error: nErr } = await supabase.from('project_nodes').select('*');
  if (nErr) throw nErr;
  const byProject = new Map();
  for (const n of allNodes || []) {
    if (!byProject.has(n.project_id)) byProject.set(n.project_id, []);
    byProject.get(n.project_id).push(n);
  }

  // BACKUP toàn bộ node nhánh D (luôn ghi, kể cả dry run).
  const backup = (allNodes || [])
    .filter((n) => n.node_id[0] === 'D')
    .map((n) => ({ ...n, project_code: codeById.get(n.project_id) || null }));
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`backup: ${backup.length} node nhánh D -> ${BACKUP_FILE}\n`);

  const plannedSupported = (allNodes || []).length === 0 || 'planned_date' in (allNodes[0] || {});
  if (!plannedSupported) console.log('(⚠ cột planned_date không tồn tại -> bỏ qua mốc ngày dự kiến)\n');

  console.log('project_nodes:');
  let migrated = 0;
  let skipped = 0;
  for (const project of projects || []) {
    const nodes = byProject.get(project.id) || [];
    try {
      const res = await migrateProject(supabase, project, nodes, plannedSupported);
      if (res.skipped) {
        skipped++;
        console.log(`  - [${project.code}] BỎ QUA: ${res.skipped}`);
      } else {
        migrated++;
        console.log(`  ✓ [${project.code}] ${res.detail}`);
      }
    } catch (e) {
      console.error(`  ✗ [${project.code}] LỖI: ${e.message}`);
      throw e; // dừng để không migrate nửa chừng
    }
  }

  console.log('\nmaster_nodes (đồng bộ với WORKFLOW_NODES):');
  for (const line of await syncMasterNodes(supabase)) console.log(line);
  console.log('  D5 -> xoá');

  console.log(`\nTổng: ${migrated} dự án gộp, ${skipped} bỏ qua.`);
  if (!APPLY) console.log('\n>> Đây là DRY RUN. Chạy lại kèm --apply để ghi vào DB.\n');
  else console.log('\n>> Đã ghi vào DB.\n');
}

main().catch((e) => {
  console.error('\nMIGRATION THẤT BẠI:', e.message, '\n');
  process.exit(1);
});
