/*
 * Migration: bỏ bước G4 (Nhập kho) + hoán đổi TOÀN BỘ G2 <-> G3 cho dự án ĐÃ CÓ trong DB.
 *
 * Vì sao cần: file WORKFLOW_NODES chỉ áp dụng cho dự án TẠO MỚI. Dự án cũ đã seed node
 * theo bố cục cũ (G2 = Sản xuất lô đầu, G3 = Kiểm tra cảm quan, G4 = Nhập kho), nên phải
 * cập nhật thủ công một lần.
 *
 * Làm gì:
 *   1) master_nodes: cập nhật tên/phòng/thời lượng G2, G3 theo bố cục mới; xoá dòng G4.
 *      (node_name hiển thị lấy từ master_nodes, nên bước này đổi tên cho MỌI dự án.)
 *   2) project_nodes của từng dự án còn G4:
 *        - HOÁN ĐỔI TOÀN BỘ dữ liệu tiến độ giữa G2 và G3:
 *          status, pic, duration, actual_date, notes, dept, attachments.
 *          -> công việc thực tế (đã xong / ngày thực tế / file đính kèm) đi theo đúng
 *             nội dung bước, chỉ đổi mã. Cột `after` GIỮ NGUYÊN (G2<-G1, G3<-G2) nên
 *             chuỗi phụ thuộc G1 -> G2 -> G3 không đổi.
 *        - Tính lại planned_date (baseline ngày dự kiến) theo duration mới + lịch làm việc.
 *        - Xoá node G4.
 *
 * An toàn: chạy KHÔNG cờ = DRY RUN (chỉ in ra, không ghi). Thêm `--apply` để ghi thật.
 * Idempotent: chỉ hoán đổi ở dự án CÒN node G4; chạy lại sau khi đã migrate sẽ bỏ qua.
 *
 * Chạy:
 *   node backend/scripts/migrate-g4-swap-g2g3.js          # xem trước (dry run)
 *   node backend/scripts/migrate-g4-swap-g2g3.js --apply  # thực thi
 */

require('../src/config/env'); // nạp .env (dotenv)
const { getSupabaseClient } = require('../src/config/supabaseClient');
const { computeAllDates, isoLocal } = require('../src/utils/datePlanner');

const APPLY = process.argv.includes('--apply');

// Các cột "tiến độ" hoán đổi giữa G2 và G3. KHÔNG đổi: id, project_id, node_id, after,
// created_at, updated_at (giữ nguyên chuỗi phụ thuộc và khoá).
const SWAP_FIELDS = ['status', 'pic', 'duration', 'actual_date', 'notes', 'dept', 'attachments'];

// Giá trị master mới (đồng bộ với backend/src/constants/workflowNodes.js).
const MASTER_G2 = { name: 'Kiểm tra cảm quan mẫu', dept: 'RD', default_duration: 8, default_after: ['G1'] };
const MASTER_G3 = { name: 'Sản xuất lô đầu và kiểm nghiệm', dept: 'PP', default_duration: 60, default_after: ['G2'] };

// Baseline "ngày dự kiến": tính từ start_date + duration + after, BỎ QUA actual_date
// (giống projectService.baselinePlannedDates). Trả về { node_id: 'YYYY-MM-DD' | null }.
function baselinePlannedDates(project, nodes) {
  const detail = {
    project,
    nodes: nodes.map((n) => ({
      node_id: n.node_id,
      after: n.after || [],
      duration: n.duration,
      status: n.status,
      actual_date: null,
    })),
  };
  const dates = computeAllDates(detail);
  const out = {};
  for (const n of nodes) {
    const d = dates[n.node_id];
    out[n.node_id] = d ? isoLocal(d.due) : null;
  }
  return out;
}

async function updateMasterNodes(supabase) {
  const steps = [];
  for (const [code, m] of [['G2', MASTER_G2], ['G3', MASTER_G3]]) {
    if (APPLY) {
      const { error } = await supabase.from('master_nodes').update(m).eq('code', code);
      if (error) throw new Error(`master_nodes ${code}: ${error.message}`);
    }
    steps.push(`  master ${code} -> "${m.name}" (${m.dept}, ${m.default_duration}n)`);
  }
  if (APPLY) {
    const { error } = await supabase.from('master_nodes').delete().eq('code', 'G4');
    if (error) throw new Error(`master_nodes delete G4: ${error.message}`);
  }
  steps.push('  master G4 -> xoá');
  return steps;
}

async function migrateProject(supabase, project, nodes, plannedSupported) {
  const g2 = nodes.find((n) => n.node_id === 'G2');
  const g3 = nodes.find((n) => n.node_id === 'G3');
  const g4 = nodes.find((n) => n.node_id === 'G4');

  if (!g4) return { skipped: 'không còn G4 (đã migrate?)' };
  if (!g2 || !g3) return { skipped: 'thiếu G2 hoặc G3' };

  // 1) Dựng tập node SAU khi hoán đổi (bỏ G4) để tính lại planned_date.
  const swappedNodes = nodes
    .filter((n) => n.node_id !== 'G4')
    .map((n) => {
      if (n.node_id === 'G2') return { ...n, duration: g3.duration, status: g3.status };
      if (n.node_id === 'G3') return { ...n, duration: g2.duration, status: g2.status };
      return n;
    });
  const planned = plannedSupported ? baselinePlannedDates(project, swappedNodes) : null;

  // 2) Payload hoán đổi: G2 nhận dữ liệu của G3 cũ, và ngược lại.
  const pick = (row) => Object.fromEntries(SWAP_FIELDS.map((f) => [f, row[f]]));
  const g2Payload = pick(g3);
  const g3Payload = pick(g2);
  if (planned) {
    g2Payload.planned_date = planned.G2 ?? null;
    g3Payload.planned_date = planned.G3 ?? null;
  }

  if (APPLY) {
    const upd = (nodeId, payload) =>
      supabase.from('project_nodes').update(payload).eq('project_id', project.id).eq('node_id', nodeId);
    let r = await upd('G2', g2Payload);
    if (r.error) throw new Error(`P${project.id} G2: ${r.error.message}`);
    r = await upd('G3', g3Payload);
    if (r.error) throw new Error(`P${project.id} G3: ${r.error.message}`);
    r = await supabase.from('project_nodes').delete().eq('project_id', project.id).eq('node_id', 'G4');
    if (r.error) throw new Error(`P${project.id} delete G4: ${r.error.message}`);
  }

  return {
    done: true,
    detail:
      `G2: dur ${g2.duration}->${g3.duration}, dept ${g2.dept}->${g3.dept}, status "${g2.status}"->"${g3.status}"` +
      ` | G3: dur ${g3.duration}->${g2.duration}, dept ${g3.dept}->${g2.dept}, status "${g3.status}"->"${g2.status}"` +
      ` | G4 (${g4.status}) xoá`,
  };
}

async function main() {
  const supabase = getSupabaseClient();
  console.log(`\n=== Migration G4/G2-G3 === (${APPLY ? 'APPLY - GHI DB' : 'DRY RUN - chỉ xem'})\n`);

  // master_nodes
  console.log('master_nodes:');
  for (const line of await updateMasterNodes(supabase)) console.log(line);

  // Dự án + node
  const { data: projects, error: pErr } = await supabase
    .from('projects')
    .select('id,code,name,start_date')
    .order('code', { ascending: true });
  if (pErr) throw pErr;

  const { data: allNodes, error: nErr } = await supabase.from('project_nodes').select('*');
  if (nErr) throw nErr;
  const byProject = new Map();
  for (const n of allNodes || []) {
    if (!byProject.has(n.project_id)) byProject.set(n.project_id, []);
    byProject.get(n.project_id).push(n);
  }

  // planned_date có thể chưa có cột (dự án cũ trước sql/planned-date.sql) -> tự dò.
  const plannedSupported = (allNodes || []).length === 0 || 'planned_date' in (allNodes[0] || {});
  if (!plannedSupported) console.log('\n(⚠ cột planned_date không tồn tại -> bỏ qua tính baseline)');

  console.log('\nproject_nodes:');
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

  console.log(`\nTổng: ${migrated} dự án hoán đổi, ${skipped} bỏ qua.`);
  if (!APPLY) console.log('\n>> Đây là DRY RUN. Chạy lại kèm --apply để ghi vào DB.\n');
  else console.log('\n>> Đã ghi vào DB.\n');
}

main().catch((e) => {
  console.error('\nMIGRATION THẤT BẠI:', e.message, '\n');
  process.exit(1);
});
