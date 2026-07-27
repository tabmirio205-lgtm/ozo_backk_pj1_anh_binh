-- Thêm cột TÊN RIÊNG cho từng node của dự án.
-- Lý do: trước đây node_name lấy từ bảng master_nodes DÙNG CHUNG (join theo mã), nên
-- đổi/gộp bước trong quy trình sẽ làm đổi tên cả dự án CŨ. Lưu tên riêng trên mỗi node
-- giúp dự án cũ giữ nguyên bố cục dù quy trình mẫu thay đổi.
--
-- Chạy 1 lần trong Supabase SQL Editor. Sau đó chạy:
--   node backend/scripts/migrate-merge-d2d3.js --apply
-- để điền tên cho dữ liệu cũ (backfill) và cập nhật master theo bố cục mới.

alter table public.project_nodes add column if not exists name text;
