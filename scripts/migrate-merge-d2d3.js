/*
 * Migration: gộp D2+D3 thành "Pha mẫu & sửa mẫu" (dồn số nhánh D) cho DỰ ÁN MỚI,
 * đồng thời ĐÓNG BĂNG bố cục dự án CŨ bằng cột tên riêng project_nodes.name.
 *
 * Bối cảnh: node_name vốn lấy từ master_nodes DÙNG CHUNG. Đổi quy trình sẽ đổi tên cả
 * dự án cũ. Nên ta:
 *   1) Backfill project_nodes.name = tên master HIỆN TẠI (bố cục cũ) cho MỌI node đang
 *      trống -> dự án cũ giữ nguyên tên/bố cục dù master đổi.
 *   2) Cập nhật master_nodes sang bố cục MỚI nhánh D (D2 gộp, D3=Phê duyệt NCC,
 *      D4=Theo dõi ổn định, E1 phụ thuộc D3) và xoá master D5 (bố cục mới không dùng).
 *
 * Dự án cũ KHÔNG bị đổi cấu trúc: vẫn D1..D5 với tên riêng đã đóng băng.
 * Dự án tạo MỚI: seed thẳng từ WORKFLOW_NODES (đã gộp) -> D1..D4.
 *
 * Bắt buộc chạy sql/project-node-name.sql (thêm cột name) TRƯỚC.
 *
 * Chạy:
 *   node backend/scripts/migrate-merge-d2d3.js           # xem trước (dry run)
 *   node backend/scripts/migrate-merge-d2d3.js --apply   # thực thi
 */

require('../src/config/env');
const { getSupabaseClient } = require('../src/config/supabaseClient');

const APPLY = process.argv.includes('--apply');

// Bố cục MỚI nhánh D (đồng bộ với backend/src/constants/workflowNodes.js).
const MASTER_UPDATES = [
  { code: 'D2', name: 'Pha mẫu & sửa mẫu', dept: 'PP', default_duration: 25, default_after: ['B7'] },
  { code: 'D3', name: 'Phê duyệt NCC gia công', dept: 'PP', default_duration: 7, default_after: ['D2'] },
  { code: 'D4', name: 'Theo dõi độ ổn định chính thức tại nhà máy', dept: 'PP', default_duration: 90, default_after: ['D3'] },
  { code: 'E1', name: 'Soạn hồ sơ công bố', dept: '', default_duration: 7, default_after: ['D3'] },
];

async function main() {
  const supabase = getSupabaseClient();
  console.log(`\n=== Migration gộp D2+D3 === (${APPLY ? 'APPLY - GHI DB' : 'DRY RUN - chỉ xem'})\n`);

  // 0) Cột name đã tồn tại chưa?
  const probe = await supabase.from('project_nodes').select('id,name').limit(1);
  if (probe.error) {
    console.error('LỖI: có vẻ cột `name` chưa tồn tại. Hãy chạy sql/project-node-name.sql trước.');
    console.error('  Chi tiết:', probe.error.message);
    process.exit(1);
  }

  // 1) Backfill tên riêng cho dự án CŨ từ master HIỆN TẠI (chỉ chỗ đang trống).
  //    Đọc master TRƯỚC khi cập nhật ở bước 2 -> lấy đúng tên cũ.
  const { data: master, error: mErr } = await supabase.from('master_nodes').select('code,name');
  if (mErr) throw mErr;

  console.log('1) Backfill project_nodes.name (chỉ node đang trống tên):');
  let totalFilled = 0;
  for (const m of master) {
    const { count, error: cErr } = await supabase
      .from('project_nodes')
      .select('id', { count: 'exact', head: true })
      .eq('node_id', m.code)
      .is('name', null);
    if (cErr) throw cErr;
    if (!count) continue;
    console.log(`   ${m.code}: ${count} node -> "${m.name}"`);
    totalFilled += count;
    if (APPLY) {
      const { error } = await supabase
        .from('project_nodes')
        .update({ name: m.name })
        .eq('node_id', m.code)
        .is('name', null);
      if (error) throw error;
    }
  }
  console.log(`   => tổng ${totalFilled} node ${APPLY ? 'đã' : 'sẽ'} điền tên.`);

  // 2) Cập nhật master sang bố cục mới (cho dự án mới + fallback), xoá D5 thừa.
  console.log('\n2) Cập nhật master_nodes:');
  for (const u of MASTER_UPDATES) {
    console.log(`   ${u.code} -> "${u.name}" (${u.dept || '—'}, ${u.default_duration}n) after=${JSON.stringify(u.default_after)}`);
    if (APPLY) {
      const { code, ...fields } = u;
      const { error } = await supabase.from('master_nodes').update(fields).eq('code', code);
      if (error) throw error;
    }
  }
  console.log('   D5 -> xoá khỏi master (bố cục mới không dùng)');
  if (APPLY) {
    const { error } = await supabase.from('master_nodes').delete().eq('code', 'D5');
    if (error) throw error;
  }

  console.log(`\n${APPLY ? '>> Đã ghi vào DB.' : '>> DRY RUN — chạy lại kèm --apply để ghi.'}\n`);
}

main().catch((e) => {
  console.error('\nMIGRATION THẤT BẠI:', e.message, '\n');
  process.exit(1);
});
