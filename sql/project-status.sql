  -- Thêm cột TRẠNG THÁI cho DỰ ÁN (khác với status của từng bước ở project_nodes).
  -- 3 giá trị: 'Đang hoạt động' | 'Pending' | 'Hoàn tất'.
  -- Chỉ ADMIN (role = manager) mới sửa được, ở modal "Sửa thông tin dự án".
  -- Trang Tổng quan có bộ lọc theo trạng thái này.
  --
  -- Chạy 1 lần trong Supabase SQL Editor.

  alter table public.projects
    add column if not exists status text not null default 'Đang hoạt động';

  -- Chuẩn hoá dữ liệu cũ (nếu có bản ghi rỗng/NULL trước khi đặt default).
  update public.projects
  set status = 'Đang hoạt động'
  where status is null or btrim(status) = '';

  -- Chặn giá trị lạ lọt vào DB.
  alter table public.projects
    drop constraint if exists projects_status_check;

  alter table public.projects
    add constraint projects_status_check
    check (status in ('Đang hoạt động', 'Pending', 'Hoàn tất'));
