const WORKFLOW_NODES = [
  { code: 'A1', stage: 'A. Ý tưởng & Duyệt', name: 'Phê duyệt triển khai dự án', dept: 'RD', defaultDuration: 15, defaultAfter: [] },
  { code: 'B1', stage: 'B. Nghiên cứu bào chế', name: 'Chuẩn bị nguyên liệu nghiên cứu', dept: 'PP', defaultDuration: 15, defaultAfter: ['A1'] },
  { code: 'B2', stage: 'B. Nghiên cứu bào chế', name: 'Nghiên cứu bào chế', dept: 'RD', defaultDuration: 15, defaultAfter: ['B1'] },
  { code: 'B3', stage: 'B. Nghiên cứu bào chế', name: 'Đánh giá cảm quan', dept: 'RD', defaultDuration: 3, defaultAfter: ['B2'] },
  { code: 'B4', stage: 'B. Nghiên cứu bào chế', name: 'Đánh giá tác dụng sơ bộ', dept: 'RD', defaultDuration: 15, defaultAfter: ['B2'] },
  { code: 'B5', stage: 'B. Nghiên cứu bào chế', name: 'Chốt mẫu nghiên cứu', dept: 'RD', defaultDuration: 3, defaultAfter: ['B3', 'B4'] },
  { code: 'B6', stage: 'B. Nghiên cứu bào chế', name: 'Theo dõi sự ổn định', dept: 'RD', defaultDuration: 60, defaultAfter: ['B5'] },
  { code: 'B7', stage: 'B. Nghiên cứu bào chế', name: 'Order pha mẫu nhà máy', dept: 'RD', defaultDuration: 1, defaultAfter: ['B5'] },
  { code: 'B8', stage: 'B. Nghiên cứu bào chế', name: 'Xây dựng hồ sơ sản phẩm dự kiến', dept: 'RD', defaultDuration: 3, defaultAfter: ['B5'] },
  { code: 'C1', stage: 'C. Bao bì', name: 'Ý tưởng bao bì', dept: 'TK', defaultDuration: 14, defaultAfter: ['A1'] },
  { code: 'C2', stage: 'C. Bao bì', name: 'Mẫu bao bì', dept: 'PP', defaultDuration: 14, defaultAfter: ['C1'] },
  { code: 'C3', stage: 'C. Bao bì', name: 'Ý tưởng thiết kế', dept: 'TK', defaultDuration: 7, defaultAfter: ['B5', 'C2'] },
  { code: 'C4', stage: 'C. Bao bì', name: 'Thiết kế bao bì', dept: 'TK', defaultDuration: 7, defaultAfter: ['E1', 'C3'] },
  { code: 'C5', stage: 'C. Bao bì', name: 'Thiết kế duyệt in', dept: 'TK', defaultDuration: 3, defaultAfter: ['E2'] },
  { code: 'D1', stage: 'D. Khả thi sản xuất', name: 'Đánh giá khả thi công bố', dept: '', defaultDuration: 5, defaultAfter: ['B8'] },
  { code: 'D2', stage: 'D. Khả thi sản xuất', name: 'Pha mẫu & sửa mẫu', dept: 'PP', defaultDuration: 25, defaultAfter: ['B7'] },
  { code: 'D3', stage: 'D. Khả thi sản xuất', name: 'Phê duyệt NCC gia công', dept: 'PP', defaultDuration: 7, defaultAfter: ['D2'] },
  { code: 'D4', stage: 'D. Khả thi sản xuất', name: 'Theo dõi độ ổn định chính thức tại nhà máy', dept: 'PP', defaultDuration: 90, defaultAfter: ['D3'] },
  { code: 'E1', stage: 'E. Công bố', name: 'Soạn hồ sơ công bố', dept: '', defaultDuration: 7, defaultAfter: ['D3'] },
  { code: 'E2', stage: 'E. Công bố', name: 'Duyệt hồ sơ', dept: '', defaultDuration: 15, defaultAfter: ['C4'] },
  { code: 'E3', stage: 'E. Công bố', name: 'Đăng ký quảng cáo', dept: 'PC', defaultDuration: 20, defaultAfter: ['E2'] },
  { code: 'F1', stage: 'F. Ra mắt & Truyền thông', name: 'Đào tạo sản phẩm', dept: 'RD', defaultDuration: 14, defaultAfter: ['E2'] },
  { code: 'F2', stage: 'F. Ra mắt & Truyền thông', name: 'Chuẩn bị launching', dept: 'Sale', defaultDuration: 30, defaultAfter: ['F1'] },
  { code: 'G1', stage: 'G. Sản xuất lô đầu', name: 'Xây dựng tài liệu sản xuất', dept: 'RD', defaultDuration: 3, defaultAfter: ['C5'] },
  { code: 'G2', stage: 'G. Sản xuất lô đầu', name: 'Kiểm tra cảm quan mẫu', dept: 'RD', defaultDuration: 8, defaultAfter: ['G1'] },
  { code: 'G3', stage: 'G. Sản xuất lô đầu', name: 'Sản xuất lô đầu và kiểm nghiệm', dept: 'PP', defaultDuration: 60, defaultAfter: ['G2'] },
];

const NODE_INDEX = Object.fromEntries(WORKFLOW_NODES.map((node) => [node.code, node]));

module.exports = { WORKFLOW_NODES, NODE_INDEX };

