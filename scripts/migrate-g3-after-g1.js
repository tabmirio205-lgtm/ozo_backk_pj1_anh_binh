/*
 * Migration: G3 chạy SONG SONG với G2 (cùng sau G1), G2 có SỐ NGÀY BẰNG G3,
 * đồng thời ĐỒNG BỘ master_nodes theo WORKFLOW_NODES (xoá mã thừa).
 *
 * Bối cảnh: WORKFLOW_NODES chỉ áp dụng cho dự án TẠO MỚI. Dự án cũ đã seed
 * project_nodes theo bố cục cũ (G3 sau G2, G2 = 8 ngày) nên phải cập nhật một lần.
 * Chạy lại được nhiều lần: dự án nào tạo trước khi source đổi sẽ được sửa, dự án
 * đã đúng thì bỏ qua.
 *
 * Làm gì:
 *   1) project_nodes của TỪNG dự án:
 *        - G3.after: bỏ 'G2', thêm 'G1'  ->  G3 không còn chờ G2 xong.
 *        - G2.duration = duration của G3 TRONG CHÍNH DỰ ÁN ĐÓ (giữ số ngày đã tuỳ
 *          chỉnh riêng của dự án, chỉ đồng bộ G2 theo G3).
 *        - Tính lại planned_date CHỈ cho G2/G3 (mốc gốc của các bước khác giữ nguyên;
 *          không bước nào phụ thuộc G2/G3 nên phần còn lại không đổi).
 *   2) master_nodes: upsert toàn bộ theo WORKFLOW_NODES và XOÁ mã không còn trong
 *      quy trình (vd G4 "Nhập kho", D5 cũ) -> tránh dòng thừa làm sai tên hiển thị.
 *
 * An toàn: chạy KHÔNG cờ = DRY RUN (chỉ in ra, không ghi). Thêm `--apply` để ghi thật.
 * Dự án còn node G4 (chưa chạy migrate-g4-swap-g2g3.js) sẽ bị BỎ QUA để tránh sai lệch.
 *
 * Chạy:
 *   node backend/scripts/migrate-g3-after-g1.js          # xem trước (dry run)
 *   node backend/scripts/migrate-g3-after-g1.js --apply  # thực thi
 */

require('../src/config/env'); // nạp .env (dotenv)
const { getSupabaseClient } = require('../src/config/supabaseClient');
const { WORKFLOW_NODES } = require('../src/constants/workflowNodes');
const { computeAllDates, isoLocal } = require('../src/utils/datePlanner');

const APPLY = process.argv.includes('--apply');

// Baseline "ngày dự kiến": tính từ start_date + duration + after, BỎ QUA actual_date
// (giống projectService.baselinePlannedDates). Trả về { node_id: 'YYYY-MM-DD' | null }.
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

// G3 mới: bỏ G2 khỏi `after`, đảm bảo có G1 (giữ phụ thuộc khác nếu ai đó đã thêm).
function newG3After(after) {
  const kept = (after || []).filter((a) => a !== 'G2');
  if (!kept.includes('G1')) kept.unshift('G1');
  return kept;
}

async function migrateProject(supabase, project, nodes, plannedSupported) {
  const g2 = nodes.find((n) => n.node_id === 'G2');
  const g3 = nodes.find((n) => n.node_id === 'G3');
  const g4 = nodes.find((n) => n.node_id === 'G4');

  if (g4) return { skipped: 'còn node G4 -> chạy migrate-g4-swap-g2g3.js trước' };
  if (!g2 || !g3) return { skipped: 'thiếu G2 hoặc G3' };

  const g3After = newG3After(g3.after);
  const g2Duration = g3.duration; // G2 lấy đúng số ngày của G3 trong dự án này

  // 1) Dựng tập node SAU khi đổi để tính lại planned_date của G2/G3.
  const nextNodes = nodes.map((n) => {
    if (n.node_id === 'G2') return { ...n, duration: g2Duration };
    if (n.node_id === 'G3') return { ...n, after: g3After };
    return n;
  });
  const planned = plannedSupported ? baselinePlannedDates(project, nextNodes) : null;

  // 2) Gom payload cần ghi.
  const updates = new Map(); // node_id -> payload
  const setField = (nodeId, field, value) => {
    if (!updates.has(nodeId)) updates.set(nodeId, {});
    updates.get(nodeId)[field] = value;
  };

  const durChanged = g2.duration !== g2Duration;
  const afterChanged = !sameArr(g3.after, g3After);
  if (durChanged) setField('G2', 'duration', g2Duration);
  if (afterChanged) setField('G3', 'after', g3After);

  // CHỈ tính lại planned_date cho G2/G3, và CHỈ khi dự án này thật sự đổi cấu trúc.
  // planned_date là mốc gốc ĐÓNG BĂNG lúc tạo dự án: dự án đã đúng bố cục mà mốc
  // lệch baseline (do sửa số ngày sau đó) thì phải GIỮ NGUYÊN, không ghi đè.
  // Không node nào phụ thuộc G2/G3 nên phần còn lại của dự án cũng không đổi.
  if (planned && (durChanged || afterChanged)) {
    for (const n of nodes.filter((x) => x.node_id === 'G2' || x.node_id === 'G3')) {
      const next = planned[n.node_id] ?? null;
      if ((n.planned_date || null) !== next) setField(n.node_id, 'planned_date', next);
    }
  }

  if (updates.size === 0) return { skipped: 'đã đúng bố cục mới' };

  if (APPLY) {
    for (const [nodeId, payload] of updates) {
      const { error } = await supabase
        .from('project_nodes')
        .update(payload)
        .eq('project_id', project.id)
        .eq('node_id', nodeId);
      if (error) throw new Error(`P${project.id} ${nodeId}: ${error.message}`);
    }
  }

  const dateChanged = [...updates].filter(([, p]) => 'planned_date' in p).length;
  return {
    done: true,
    detail:
      `G2: dur ${g2.duration}->${g2Duration}` +
      ` | G3: after [${(g3.after || []).join(',')}]->[${g3After.join(',')}]` +
      (planned ? ` | ${dateChanged} node đổi ngày dự kiến` : ' | (bỏ qua ngày dự kiến)'),
  };
}

// master_nodes phải luôn khớp WORKFLOW_NODES: createProject() có upsert master, nhưng
// KHÔNG xoá mã cũ -> phải dọn ở đây (vd G4 'Nhập kho', D5 của bố cục cũ).
async function syncMasterNodes(supabase) {
  const rows = WORKFLOW_NODES.map((n) => ({
    code: n.code,
    stage: n.stage,
    name: n.name,
    dept: n.dept,
    default_duration: n.defaultDuration,
    default_after: n.defaultAfter,
  }));
  const { data: current, error } = await supabase.from('master_nodes').select('code,name,default_duration,default_after');
  if (error) throw error;

  const src = new Map(rows.map((r) => [r.code, r]));
  const lines = [];
  for (const m of current || []) {
    const r = src.get(m.code);
    if (!r) {
      lines.push(`  ${m.code} "${m.name}" -> XOÁ (không còn trong quy trình)`);
      continue;
    }
    const diff = [];
    if (m.name !== r.name) diff.push(`name "${m.name}"->"${r.name}"`);
    if (m.default_duration !== r.default_duration) diff.push(`dur ${m.default_duration}->${r.default_duration}`);
    if ((m.default_after || []).join() !== (r.default_after || []).join())
      diff.push(`after [${(m.default_after || []).join()}]->[${(r.default_after || []).join()}]`);
    if (diff.length) lines.push(`  ${m.code}: ${diff.join(' | ')}`);
  }
  for (const code of src.keys()) if (!(current || []).some((m) => m.code === code)) lines.push(`  ${code}: THÊM MỚI`);

  if (APPLY) {
    const up = await supabase.from('master_nodes').upsert(rows, { onConflict: 'code' });
    if (up.error) throw new Error(`master_nodes upsert: ${up.error.message}`);
    const stale = (current || []).map((m) => m.code).filter((c) => !src.has(c));
    if (stale.length) {
      const del = await supabase.from('master_nodes').delete().in('code', stale);
      if (del.error) throw new Error(`master_nodes xoá [${stale.join(',')}]: ${del.error.message}`);
    }
  }
  return lines.length ? lines : ['  (đã khớp WORKFLOW_NODES)'];
}

async function main() {
  const supabase = getSupabaseClient();
  console.log(`\n=== Migration G3 sau G1 + G2 = G3 ngày === (${APPLY ? 'APPLY - GHI DB' : 'DRY RUN - chỉ xem'})\n`);

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
  if (!plannedSupported) console.log('(⚠ cột planned_date không tồn tại -> bỏ qua tính baseline)\n');

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

  console.log(`\nTổng: ${migrated} dự án cập nhật, ${skipped} bỏ qua.`);
  if (!APPLY) console.log('\n>> Đây là DRY RUN. Chạy lại kèm --apply để ghi vào DB.\n');
  else console.log('\n>> Đã ghi vào DB.\n');
}

main().catch((e) => {
  console.error('\nMIGRATION THẤT BẠI:', e.message, '\n');
  process.exit(1);
});
