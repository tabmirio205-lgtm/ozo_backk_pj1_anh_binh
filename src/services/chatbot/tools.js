// Bộ công cụ (function calling) cho chatbot. Mỗi tool gồm:
//  - declaration: mô tả cho Gemini
//  - execute(args, ctx): thực thi, ctx = { authed, email, picName }
// Tool ĐỌC: ai cũng gọi được. Tool GHI: chỉ PIC, và chỉ node có pic = tên mình.

const {
  listProjects,
  listProjectsWithNodes,
  getProjectDetail,
  getProjectNode,
  updateProjectNode,
  startReadySuccessors,
  revertDependentsToNotStarted,
  getUnsatisfiedDeps,
} = require('../projectService');
const { WORKFLOW_NODES, NODE_INDEX } = require('../../constants/workflowNodes');
const { computeAllDates, lateDays, isoLocal, todayIsoVN } = require('../../utils/datePlanner');
const { findMemberByName, listAllMembers } = require('../picMembersService');
const { toPicArray, picText } = require('../../utils/pic');
const {
  notifyAssignment,
  notifyStepsStarted,
  notifyStepCompleted,
  snapshotDueDates,
  notifyDueDateChanges,
  affectsDueDates,
} = require('../reminders/reminderService');
const {
  sendTextByOpenId,
  sendTextByEmail,
  isLarkConfigured,
} = require('../lark/larkClient');

// Gửi 1 DM cho 1 thành viên: ưu tiên open_id, lỗi thì fallback email.
async function dmContact(member, text) {
  if (member.open_id) {
    const r = await sendTextByOpenId(member.open_id, text);
    if (r && r.code === 0) return { ok: true, via: 'open_id' };
    if (member.email) {
      const r2 = await sendTextByEmail(member.email, text);
      if (r2 && r2.code === 0) return { ok: true, via: 'email' };
      return { ok: false, err: r2?.msg || r?.msg };
    }
    return { ok: false, err: r?.msg };
  }
  if (member.email) {
    const r = await sendTextByEmail(member.email, text);
    return r && r.code === 0 ? { ok: true, via: 'email' } : { ok: false, err: r?.msg };
  }
  return { ok: false, err: 'no-contact' };
}

const STATUS_OPTIONS = ['Chưa làm', 'Đang làm', 'Đã xong', 'Tạm dừng', 'Bỏ qua'];

// ---------- Helpers ----------

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

// Tìm dự án theo id / code / tên (khớp gần đúng).
async function resolveProject(query) {
  const q = norm(query);
  const projects = await listProjects();
  if (!q) return { match: null, candidates: projects };

  // 1) id chính xác
  if (/^\d+$/.test(q)) {
    const byId = projects.find((p) => String(p.id) === q);
    if (byId) return { match: byId, candidates: [] };
  }
  // 2) code chính xác
  const byCode = projects.find((p) => norm(p.code) === q);
  if (byCode) return { match: byCode, candidates: [] };
  // 3) tên/ code chứa chuỗi
  const contains = projects.filter(
    (p) => norm(p.name).includes(q) || norm(p.code).includes(q),
  );
  if (contains.length === 1) return { match: contains[0], candidates: [] };
  return { match: null, candidates: contains.length ? contains : projects };
}

function summarizeNode(detail, node, dates) {
  const late = lateDays(detail, node.node_id, dates);
  const d = dates[node.node_id];
  return {
    code: node.node_id,
    name: node.node_name,
    stage: node.stage,
    status: node.status,
    pic: picText(node.pic) || '(chưa gán)',
    dept: node.dept || '',
    duration: node.duration,
    after: node.after || [],
    start: d ? isoLocal(d.start) : null,
    due: d ? isoLocal(d.due) : null,
    actual_date: node.actual_date || null,
    late_days: late,
    notes: node.notes || '',
  };
}

function candidateError(candidates) {
  return {
    error: 'Không xác định được 1 dự án duy nhất.',
    candidates: candidates.slice(0, 12).map((p) => ({ id: p.id, code: p.code, name: p.name })),
    hint: 'Hãy hỏi lại người dùng chọn đúng code/tên dự án.',
  };
}

// ---------- Tools ----------

const tools = {
  list_projects: {
    declaration: {
      name: 'list_projects',
      description: 'Liệt kê tất cả dự án (id, code, tên, loại, nhóm, chủ dự án, ngày bắt đầu).',
      parameters: { type: 'OBJECT', properties: {} },
    },
    async execute() {
      const projects = await listProjects();
      return { count: projects.length, projects };
    },
  },

  get_project: {
    declaration: {
      name: 'get_project',
      description:
        'Lấy chi tiết 1 dự án và toàn bộ các bước (node): trạng thái, PIC, phòng ban, ngày bắt đầu/hạn dự kiến (đã trừ T7/CN + lễ VN), số ngày trễ, ghi chú.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'id, code hoặc tên dự án' },
        },
        required: ['query'],
      },
    },
    async execute({ query }) {
      const { match, candidates } = await resolveProject(query);
      if (!match) return candidateError(candidates);
      const detail = await getProjectDetail(match.id);
      const dates = computeAllDates(detail);
      return {
        project: detail.project,
        nodes: detail.nodes.map((n) => summarizeNode(detail, n, dates)),
      };
    },
  },

  find_late_nodes: {
    declaration: {
      name: 'find_late_nodes',
      description:
        'Tìm các bước đang TRỄ hạn (quá due mà chưa xong). Không truyền query = quét toàn bộ dự án; có query = chỉ 1 dự án.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'id/code/tên dự án (tùy chọn)' },
        },
      },
    },
    async execute({ query } = {}) {
      let targets;
      if (query && norm(query)) {
        const { match, candidates } = await resolveProject(query);
        if (!match) return candidateError(candidates);
        const detail = await getProjectDetail(match.id);
        targets = [detail];
      } else {
        targets = await listProjectsWithNodes();
      }
      const out = [];
      for (const detail of targets) {
        const dates = computeAllDates(detail);
        for (const n of detail.nodes) {
          const late = lateDays(detail, n.node_id, dates);
          if (late > 0) {
            out.push({
              project_code: detail.project.code,
              project_name: detail.project.name,
              ...summarizeNode(detail, n, dates),
            });
          }
        }
      }
      out.sort((a, b) => b.late_days - a.late_days);
      return { count: out.length, late_nodes: out };
    },
  },

  list_nodes: {
    declaration: {
      name: 'list_nodes',
      description:
        'Lọc các bước của 1 dự án theo trạng thái / phòng ban / PIC. Dùng khi cần danh sách con của 1 dự án.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'id/code/tên dự án' },
          status: { type: 'STRING', description: 'lọc theo trạng thái (tùy chọn)' },
          dept: { type: 'STRING', description: 'lọc theo phòng ban (tùy chọn)' },
          pic: { type: 'STRING', description: 'lọc theo tên PIC (tùy chọn)' },
        },
        required: ['query'],
      },
    },
    async execute({ query, status, dept, pic }) {
      const { match, candidates } = await resolveProject(query);
      if (!match) return candidateError(candidates);
      const detail = await getProjectDetail(match.id);
      const dates = computeAllDates(detail);
      let nodes = detail.nodes;
      if (status) nodes = nodes.filter((n) => norm(n.status) === norm(status));
      if (dept) nodes = nodes.filter((n) => norm(n.dept) === norm(dept));
      if (pic) nodes = nodes.filter((n) => toPicArray(n.pic).some((p) => norm(p).includes(norm(pic))));
      return {
        project: { id: match.id, code: match.code, name: match.name },
        count: nodes.length,
        nodes: nodes.map((n) => summarizeNode(detail, n, dates)),
      };
    },
  },

  projects_by_pic: {
    declaration: {
      name: 'projects_by_pic',
      description:
        'Tìm tất cả các bước đang được gán cho 1 người (PIC) trên mọi dự án. Kèm trạng thái và số ngày trễ.',
      parameters: {
        type: 'OBJECT',
        properties: {
          pic_name: { type: 'STRING', description: 'tên PIC cần tra' },
        },
        required: ['pic_name'],
      },
    },
    async execute({ pic_name }) {
      const all = await listProjectsWithNodes();
      const target = norm(pic_name);
      const out = [];
      for (const detail of all) {
        const dates = computeAllDates(detail);
        for (const n of detail.nodes) {
          if (target && toPicArray(n.pic).some((p) => norm(p).includes(target))) {
            out.push({
              project_code: detail.project.code,
              project_name: detail.project.name,
              ...summarizeNode(detail, n, dates),
            });
          }
        }
      }
      return { pic: pic_name, count: out.length, nodes: out };
    },
  },

  projects_at_stage: {
    declaration: {
      name: 'projects_at_stage',
      description:
        'Liệt kê các DỰ ÁN đang ở 1 giai đoạn/bước cụ thể theo BƯỚC HIỆN TẠI. Truyền stage = 1 chữ cái giai đoạn A–G (vd "B") hoặc mã bước cụ thể (vd "B2"). Bỏ trống = trả bước hiện tại của MỌI dự án. "Bước hiện tại" = bước "Đang làm" đầu tiên; nếu không có thì bước "Chưa làm"/"Tạm dừng" gần nhất — khớp với "Bước hiện tại" ở trang tổng quan. DÙNG tool này cho câu hỏi "dự án đang ở bước/giai đoạn nào"; KHÔNG tự bịa danh sách.',
      parameters: {
        type: 'OBJECT',
        properties: {
          stage: {
            type: 'STRING',
            description: 'giai đoạn A–G hoặc mã bước, vd "B" hoặc "B2" (tùy chọn)',
          },
        },
      },
    },
    async execute({ stage } = {}) {
      const all = await listProjectsWithNodes();
      const q = String(stage || '').trim().toUpperCase();
      const isCode = /^[A-G]\d+$/.test(q);
      const isLetter = /^[A-G]$/.test(q);
      if (q && !isCode && !isLetter) {
        return { error: `stage "${stage}" không hợp lệ. Dùng chữ cái A–G (vd "B") hoặc mã bước (vd "B2").` };
      }

      const stageOf = (code) => String(code || '').charAt(0).toUpperCase();
      const rows = [];
      for (const detail of all) {
        const nodes = detail.nodes || [];
        // Bước hiện tại: giống trang tổng quan (Đang làm > Chưa làm > Tạm dừng).
        const current =
          nodes.find((n) => n.status === 'Đang làm') ||
          nodes.find((n) => n.status === 'Chưa làm') ||
          nodes.find((n) => n.status === 'Tạm dừng') ||
          null;
        const activeSteps = nodes
          .filter((n) => n.status === 'Đang làm')
          .map((n) => ({ code: n.node_id, name: n.node_name, pic: picText(n.pic) || '(chưa gán)' }));
        rows.push({
          project_code: detail.project.code,
          project_name: detail.project.name,
          current_step: current
            ? {
                code: current.node_id,
                name: current.node_name,
                status: current.status,
                pic: picText(current.pic) || '(chưa gán)',
              }
            : null, // null = đã hoàn tất mọi bước
          active_steps: activeSteps,
        });
      }

      if (!q) return { count: rows.length, projects: rows };

      const matched = rows.filter((r) => {
        if (isCode) {
          if (r.current_step && r.current_step.code === q) return true;
          return r.active_steps.some((s) => s.code === q);
        }
        // isLetter
        if (r.current_step && stageOf(r.current_step.code) === q) return true;
        return r.active_steps.some((s) => stageOf(s.code) === q);
      });
      return { stage: q, count: matched.length, projects: matched };
    },
  },

  upcoming_deadlines: {
    declaration: {
      name: 'upcoming_deadlines',
      description:
        'Liệt kê các bước SẮP TỚI HẠN trong N ngày tới (mặc định 7), chưa "Đã xong"/"Bỏ qua". Lọc thêm theo phòng (dept) hoặc PIC. Dùng cho "tuần/tháng này có bước nào tới hạn", "deadline sắp tới của phòng X", "việc đến hạn hôm nay" (days=0). Bước ĐÃ quá hạn thì dùng find_late_nodes.',
      parameters: {
        type: 'OBJECT',
        properties: {
          days: { type: 'NUMBER', description: 'số ngày tới tính từ hôm nay (mặc định 7; tuần≈7, tháng≈30, hôm nay=0)' },
          dept: { type: 'STRING', description: 'lọc theo phòng, vd RD/TK/PP (tùy chọn)' },
          pic: { type: 'STRING', description: 'lọc theo PIC (tùy chọn)' },
        },
      },
    },
    async execute({ days, dept, pic } = {}) {
      const n = Number(days);
      const window = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 7;
      const all = await listProjectsWithNodes();
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dq = norm(dept);
      const pq = norm(pic);
      const out = [];
      for (const detail of all) {
        const dates = computeAllDates(detail);
        for (const node of detail.nodes) {
          if (node.status === 'Đã xong' || node.status === 'Bỏ qua') continue;
          if (dq && norm(node.dept) !== dq) continue;
          if (pq && !toPicArray(node.pic).some((p) => norm(p).includes(pq))) continue;
          const due = dates[node.node_id]?.due;
          if (!due) continue;
          const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
          const diff = Math.round((dueDay.getTime() - today.getTime()) / 86400000);
          if (diff < 0 || diff > window) continue;
          out.push({
            project_code: detail.project.code,
            project_name: detail.project.name,
            days_left: diff,
            ...summarizeNode(detail, node, dates),
          });
        }
      }
      out.sort((a, b) => a.days_left - b.days_left);
      return { window_days: window, count: out.length, nodes: out };
    },
  },

  nodes_by_dept: {
    declaration: {
      name: 'nodes_by_dept',
      description:
        'Liệt kê các bước của 1 PHÒNG BAN trên MỌI dự án (khối lượng việc của phòng), kèm đếm theo trạng thái. Lọc thêm theo trạng thái (status). Dùng cho "phòng RD đang làm gì", "phòng TK còn bao nhiêu việc", "việc của phòng PP".',
      parameters: {
        type: 'OBJECT',
        properties: {
          dept: { type: 'STRING', description: 'mã phòng, vd RD, TK, PP, PC, Sale' },
          status: {
            type: 'STRING',
            description: `lọc trạng thái (tùy chọn): ${STATUS_OPTIONS.join(' | ')}`,
          },
        },
        required: ['dept'],
      },
    },
    async execute({ dept, status } = {}) {
      const dq = norm(dept);
      if (!dq) return { error: 'Thiếu tên phòng.' };
      const sf = status ? norm(status) : '';
      const all = await listProjectsWithNodes();
      const out = [];
      const by_status = {};
      for (const detail of all) {
        const dates = computeAllDates(detail);
        for (const node of detail.nodes) {
          if (norm(node.dept) !== dq) continue;
          if (sf && norm(node.status) !== sf) continue;
          by_status[node.status] = (by_status[node.status] || 0) + 1;
          out.push({
            project_code: detail.project.code,
            project_name: detail.project.name,
            ...summarizeNode(detail, node, dates),
          });
        }
      }
      return { dept, count: out.length, by_status, nodes: out };
    },
  },

  project_stats: {
    declaration: {
      name: 'project_stats',
      description:
        'Thống kê tiến độ. Có query = 1 dự án (số bước xong/tổng, %, số trễ, bước hiện tại). Bỏ trống = TỔNG QUAN mọi dự án (sắp xếp chậm nhất lên đầu) + tổng số bước trễ theo phòng. Dùng cho "tiến độ dự án X bao nhiêu %", "dự án nào chậm nhất", "toàn công ty bao nhiêu bước trễ / theo phòng".',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'id/code/tên dự án (tùy chọn; bỏ trống = tổng quan)' },
        },
      },
    },
    async execute({ query } = {}) {
      const statOf = (detail) => {
        const dates = computeAllDates(detail);
        let done = 0;
        let total = 0;
        let late = 0;
        for (const node of detail.nodes) {
          if (node.status === 'Bỏ qua') continue;
          total += 1;
          if (node.status === 'Đã xong') done += 1;
          if (lateDays(detail, node.node_id, dates) > 0) late += 1;
        }
        const current =
          detail.nodes.find((n) => n.status === 'Đang làm') ||
          detail.nodes.find((n) => n.status === 'Chưa làm') ||
          detail.nodes.find((n) => n.status === 'Tạm dừng') ||
          null;
        return {
          done,
          total,
          late,
          percent: total ? Math.round((done / total) * 100) : 0,
          current_step: current ? `${current.node_id} ${current.node_name || ''}`.trim() : 'Hoàn tất',
        };
      };

      if (query && norm(query)) {
        const { match, candidates } = await resolveProject(query);
        if (!match) return candidateError(candidates);
        const detail = await getProjectDetail(match.id);
        return { project: { code: match.code, name: match.name }, ...statOf(detail) };
      }

      const all = await listProjectsWithNodes();
      const projects = [];
      const late_by_dept = {};
      let totDone = 0;
      let totTotal = 0;
      let totLate = 0;
      for (const detail of all) {
        const s = statOf(detail);
        projects.push({
          project_code: detail.project.code,
          project_name: detail.project.name,
          ...s,
        });
        totDone += s.done;
        totTotal += s.total;
        totLate += s.late;
        const dates = computeAllDates(detail);
        for (const node of detail.nodes) {
          if (lateDays(detail, node.node_id, dates) > 0) {
            const d = (node.dept || '').trim() || '(chưa gán)';
            late_by_dept[d] = (late_by_dept[d] || 0) + 1;
          }
        }
      }
      projects.sort((a, b) => a.percent - b.percent); // chậm nhất lên đầu
      return {
        total_projects: projects.length,
        total_steps: totTotal,
        total_done: totDone,
        total_percent: totTotal ? Math.round((totDone / totTotal) * 100) : 0,
        total_late: totLate,
        late_by_dept,
        projects,
      };
    },
  },

  list_members: {
    declaration: {
      name: 'list_members',
      description:
        'Danh bạ PIC / trưởng phòng. Bỏ trống = tất cả; truyền dept để lọc 1 phòng; leaders_only=true để chỉ lấy trưởng phòng. Dùng cho "ai là trưởng phòng RD", "phòng TK có những ai", "liên hệ/email của X".',
      parameters: {
        type: 'OBJECT',
        properties: {
          dept: { type: 'STRING', description: 'lọc theo phòng (tùy chọn)' },
          leaders_only: { type: 'BOOLEAN', description: 'true = chỉ trưởng phòng (tùy chọn)' },
        },
      },
    },
    async execute({ dept, leaders_only } = {}) {
      const dq = norm(dept);
      const all = await listAllMembers();
      const members = [];
      for (const m of all) {
        const leadDepts =
          Array.isArray(m.lead_depts) && m.lead_depts.length
            ? m.lead_depts
            : m.is_leader && m.dept
              ? [m.dept]
              : [];
        const isLeader = leadDepts.length > 0;
        if (leaders_only && !isLeader) continue;
        if (dq) {
          const inDept = norm(m.dept) === dq || leadDepts.some((d) => norm(d) === dq);
          if (!inDept) continue;
        }
        members.push({
          pic_name: m.pic_name,
          dept: m.dept || '',
          is_leader: isLeader,
          lead_depts: leadDepts,
          email: m.email || null,
          has_lark: !!m.open_id,
        });
      }
      return { count: members.length, members };
    },
  },

  explain_workflow: {
    declaration: {
      name: 'explain_workflow',
      description:
        'Giải thích quy trình chuẩn 27 bước (A→G). Truyền node_code để mô tả 1 bước cụ thể + bước phụ thuộc; bỏ trống để lấy toàn bộ danh sách.',
      parameters: {
        type: 'OBJECT',
        properties: {
          node_code: { type: 'STRING', description: 'mã bước ví dụ B5 (tùy chọn)' },
        },
      },
    },
    async execute({ node_code } = {}) {
      if (node_code) {
        const code = String(node_code).trim().toUpperCase();
        const node = NODE_INDEX[code];
        if (!node) return { error: `Không có bước ${code}` };
        const dependents = WORKFLOW_NODES.filter((n) => (n.defaultAfter || []).includes(code)).map(
          (n) => n.code,
        );
        return {
          node: {
            code: node.code,
            stage: node.stage,
            name: node.name,
            dept: node.dept,
            default_duration_days: node.defaultDuration,
            depends_on: node.defaultAfter,
            blocks: dependents,
          },
        };
      }
      return {
        total: WORKFLOW_NODES.length,
        nodes: WORKFLOW_NODES.map((n) => ({
          code: n.code,
          stage: n.stage,
          name: n.name,
          dept: n.dept,
          default_duration_days: n.defaultDuration,
          depends_on: n.defaultAfter,
        })),
      };
    },
  },

  whoami: {
    declaration: {
      name: 'whoami',
      description:
        'Cho biết người đang chat là ai và có quyền ghi không (dựa trên email Lark đối chiếu pic_members).',
      parameters: { type: 'OBJECT', properties: {} },
    },
    async execute(_args, ctx) {
      const leadDepts = Array.isArray(ctx.leadDepts) ? ctx.leadDepts : [];
      const isLeader = leadDepts.length > 0;
      return {
        email: ctx.email || null,
        is_pic: !!ctx.authed,
        pic_name: ctx.picName || null,
        dept: ctx.dept || null,
        is_leader: isLeader,
        lead_depts: leadDepts,
        can_edit: !ctx.authed
          ? 'Chỉ xem. Email Lark của bạn chưa nằm trong danh sách PIC.'
          : isLeader
            ? `Trưởng phòng ${leadDepts.join(', ')}: sửa mọi bước thuộc phòng này (kể cả đổi PIC), và các bước gán cho bạn. Nhờ bot gửi tin được cho mọi PIC.`
            : `Thuộc phòng ${ctx.dept || '—'}. Sửa các bước có PIC = tên bạn; được chuyển bước của mình cho PIC khác CÙNG PHÒNG. Nhờ bot gửi tin được cho PIC cùng phòng. (Bạn KHÔNG phải trưởng phòng nên không sửa được mọi bước của phòng.)`,
      };
    },
  },

  update_node: {
    declaration: {
      name: 'update_node',
      description:
        'CẬP NHẬT 1 bước của dự án. Quyền: PIC phụ trách bước đó (được CHUYỂN bước cho PIC khác CÙNG PHÒNG), hoặc TRƯỞNG PHÒNG của phòng phụ trách bước đó (đổi PIC cho bất kỳ ai). Có thể đổi status, actual_date (YYYY-MM-DD), notes, duration, pic. LUÔN xác nhận lại với người dùng trước khi ghi.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'id/code/tên dự án' },
          node_code: { type: 'STRING', description: 'mã bước, ví dụ B5' },
          status: {
            type: 'STRING',
            description: `trạng thái mới: ${STATUS_OPTIONS.join(' | ')}`,
          },
          actual_date: { type: 'STRING', description: 'ngày hoàn thành thực tế YYYY-MM-DD' },
          notes: { type: 'STRING', description: 'ghi chú' },
          pic: {
            type: 'STRING',
            description:
              'gán/ĐỔI LẠI danh sách người phụ trách (PIC) của bước. Nhiều người thì ngăn cách dấu phẩy (vd "An, Bình") — tất cả phải CÙNG PHÒNG với bước. Chỉ trưởng phòng/quản lý nên dùng.',
          },
        },
        required: ['query', 'node_code'],
      },
    },
    async execute(args, ctx) {
      if (!ctx.authed) {
        return {
          error:
            'Bạn chưa được xác thực là PIC. Email Lark của bạn cần nằm trong bảng pic_members mới được sửa.',
        };
      }
      const { match, candidates } = await resolveProject(args.query);
      if (!match) return candidateError(candidates);

      const nodeCode = String(args.node_code || '').trim().toUpperCase();
      const node = await getProjectNode(match.id, nodeCode);
      if (!node) return { error: `Dự án ${match.code} không có bước ${nodeCode}.` };

      const owners = toPicArray(node.pic);
      const nodeDept = (node.dept || '').trim();
      const isLeaderOfDept =
        Array.isArray(ctx.leadDepts) && nodeDept && ctx.leadDepts.includes(nodeDept);
      const isOwner = owners.includes((ctx.picName || '').trim());
      if (!isLeaderOfDept && !isOwner) {
        return {
          error: `Bước ${nodeCode} do "${picText(node.pic) || 'chưa gán'}" (phòng ${nodeDept || '—'}) phụ trách. Bạn chỉ sửa được bước của mình hoặc bước thuộc phòng bạn quản lý.`,
        };
      }

      // Xây payload từ các field được cung cấp.
      const payload = {};
      if (args.status !== undefined) {
        if (!STATUS_OPTIONS.includes(args.status)) {
          return { error: `Trạng thái không hợp lệ. Chọn: ${STATUS_OPTIONS.join(', ')}` };
        }
        payload.status = args.status;
      }
      if (args.actual_date !== undefined) {
        if (args.actual_date && !/^\d{4}-\d{2}-\d{2}$/.test(args.actual_date)) {
          return { error: 'actual_date phải dạng YYYY-MM-DD.' };
        }
        payload.actual_date = args.actual_date || null;
      }
      if (args.notes !== undefined) payload.notes = args.notes;
      // Số ngày (duration), Phòng (dept), Sau bước (after): chỉ cấp quản lý (nhập mã
      // trên web) mới sửa — chatbot chỉ xác thực PIC nên không cho sửa các trường này.
      if (args.pic !== undefined) {
        // Chatbot gán 'pic' -> GÁN LẠI danh sách PIC (text[]). Cho phép nhiều tên
        // ngăn cách dấu phẩy; tất cả phải CÙNG PHÒNG với bước.
        const names = String(args.pic || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!names.length) return { error: 'Tên PIC mới đang trống.' };
        const cleaned = [];
        for (const newPic of names) {
          if (isLeaderOfDept) {
            // Trưởng phòng: gán cho ai cũng được. Chuẩn hoá tên về đúng danh bạ
            // ("Ly" -> "Phạm Khánh Ly") để khớp nhắc việc; ngoài danh bạ giữ nguyên.
            const canon = await findMemberByName(newPic);
            cleaned.push(canon ? canon.pic_name : newPic);
          } else {
            // PIC thường (chủ bước): chỉ được gán PIC khác CÙNG PHÒNG với bước.
            const target = await findMemberByName(newPic);
            if (!target) {
              return { error: `Không tìm thấy PIC "${newPic}" trong danh bạ.` };
            }
            const targetDept = (target.dept || '').trim();
            if (!nodeDept || targetDept !== nodeDept) {
              return {
                error: `Chỉ được gán PIC cùng phòng ${nodeDept || '—'}. "${target.pic_name}" thuộc phòng ${targetDept || '—'}.`,
              };
            }
            cleaned.push(target.pic_name); // dùng tên chuẩn trong danh bạ
          }
        }
        payload.pic = cleaned;
      }
      // Điền NGÀY THỰC TẾ mà không nêu trạng thái -> coi như 'Đã xong' (khớp web).
      if (payload.actual_date && payload.status === undefined) {
        payload.status = 'Đã xong';
      }

      // NGÀY THỰC TẾ: PIC thường không tự chọn (khớp luật trên web) — báo 'Đã xong'
      // thì hệ thống tự đóng dấu ngày hôm nay. Trưởng phòng của bước vẫn sửa tay được.
      if (!isLeaderOfDept) delete payload.actual_date;

      // Bước đã kết thúc: PIC thường hết quyền sửa Ghi chú. Trưởng phòng của bước
      // vẫn sửa được; mở lại bước trong cùng lệnh thì cho phép.
      const nodeDone = ['Đã xong', 'Bỏ qua'].includes(node.status);
      const reopening =
        payload.status !== undefined && !['Đã xong', 'Bỏ qua'].includes(payload.status);
      if (nodeDone && !isLeaderOfDept && !reopening) {
        if (payload.notes !== undefined && (payload.notes || null) !== (node.notes || null)) {
          return {
            error: `Bước ${nodeCode} đã kết thúc — bạn không sửa được ghi chú nữa. Nhờ trưởng phòng, hoặc mở lại bước (đổi trạng thái) trước khi sửa.`,
          };
        }
        delete payload.notes;
      }

      // Báo 'Đã xong' mà chưa có ngày thực tế -> tự điền HÔM NAY (giờ VN).
      if (payload.status === 'Đã xong' && payload.actual_date === undefined && !node.actual_date) {
        payload.actual_date = todayIsoVN();
      }
      // Mở lại bước đã xong -> xoá ngày thực tế cũ.
      if (
        payload.status !== undefined &&
        payload.status !== 'Đã xong' &&
        node.status === 'Đã xong' &&
        payload.actual_date === undefined &&
        node.actual_date
      ) {
        payload.actual_date = null;
      }

      if (Object.keys(payload).length === 0) {
        return { error: 'Không có gì để cập nhật.' };
      }

      // Chặn tích 'Đã xong' khi bước phụ thuộc (after) chưa 'Đã xong'/'Bỏ qua'.
      if (payload.status === 'Đã xong') {
        const pending = await getUnsatisfiedDeps(match.id, nodeCode);
        if (pending.length) {
          return {
            error: `Chưa thể hoàn tất bước ${nodeCode}: bước phụ thuộc chưa xong/bỏ qua — ${pending.join(', ')}`,
          };
        }
      }

      // Chụp ngày dự kiến TRƯỚC khi sửa để biết bước nào bị dời mà báo PIC (xem
      // notifyDueDateChanges). Chỉ chụp khi payload có thể làm đổi ngày.
      const dueBefore = affectsDueDates(payload)
        ? await snapshotDueDates(match.id)
        : null;

      // Trạng thái có THỰC SỰ đổi lần này không (so với `node` đọc trước khi sửa)?
      // Đặt lại đúng trạng thái cũ / chỉ sửa ghi chú -> không coi là "vừa hoàn tất".
      const statusChanged =
        payload.status !== undefined && payload.status !== node.status;

      const updated = await updateProjectNode(match.id, nodeCode, payload);
      // Bước vừa 'Đã xong' hoặc 'Bỏ qua' -> báo trưởng phòng bước này + mở khoá bước kế tiếp.
      if (statusChanged && (updated.status === 'Đã xong' || updated.status === 'Bỏ qua')) {
        // (1) Báo TRƯỞNG PHÒNG của chính bước vừa xong/bỏ qua (Lark DM, chạy nền).
        notifyStepCompleted(match.id, nodeCode, updated.status).catch((e) =>
          console.error('[done-notify] lỗi:', e.message),
        );
        // (2) Mở khoá bước kế tiếp + báo cho PIC bước kế tiếp (Lark DM, chạy nền).
        const started = await startReadySuccessors(match.id, nodeCode);
        if (started && started.length) {
          notifyStepsStarted(match.id, started).catch((e) =>
            console.error('[start-notify] lỗi:', e.message),
          );
        }
      } else if (statusChanged) {
        // Bước RỜI trạng thái hoàn tất (vd 'Đã xong' -> 'Đang làm') -> các bước
        // phụ thuộc nó quay về 'Chưa làm' (đệ quy xuống chuỗi).
        await revertDependentsToNotStarted(match.id, nodeCode);
      }

      // Vừa phân/đổi PIC -> báo ngay người được giao; bước RỜI 'Tạm dừng' về trạng
      // thái đang mở cũng gửi (lúc Tạm dừng mọi DM cho PIC bị chặn — xem SILENT
      // trong reminderService — nên đây là dịp gửi bù). Dedupe nằm trong service.
      const resumedFromPause =
        statusChanged &&
        node.status === 'Tạm dừng' &&
        updated.status !== 'Đã xong' &&
        updated.status !== 'Bỏ qua';
      if (payload.pic !== undefined || resumedFromPause) {
        notifyAssignment(match.id, nodeCode).catch((e) =>
          console.error('[assign-notify] lỗi:', e.message),
        );
      }

      // Báo PIC các bước bị DỜI NGÀY DỰ KIẾN (chạy nền, sau các tác động ở trên).
      if (dueBefore) {
        notifyDueDateChanges(match.id, dueBefore).catch((e) =>
          console.error('[date-notify] lỗi:', e.message),
        );
      }

      return {
        ok: true,
        project: match.code,
        node: nodeCode,
        updated_fields: payload,
        result: {
          status: updated.status,
          actual_date: updated.actual_date,
          duration: updated.duration,
          notes: updated.notes,
        },
      };
    },
  },

  add_note: {
    declaration: {
      name: 'add_note',
      description:
        'THÊM (nối) 1 ghi chú vào 1 bước — KHÔNG xoá ghi chú cũ. Dùng khi người dùng nói "ghi chú bước ... là ...", "thêm ghi chú", "ghi chú: ...". Quyền: PIC phụ trách bước đó, hoặc TRƯỞNG PHÒNG của phòng phụ trách bước. Bot tự kèm ngày + tên người ghi. Nếu người dùng muốn GHI ĐÈ toàn bộ ghi chú thì dùng update_node.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'id/code/tên dự án' },
          node_code: { type: 'STRING', description: 'mã bước, ví dụ B5' },
          note: { type: 'STRING', description: 'nội dung ghi chú cần thêm' },
        },
        required: ['query', 'node_code', 'note'],
      },
    },
    async execute(args, ctx) {
      if (!ctx.authed) {
        return {
          error:
            'Bạn chưa được xác thực là PIC. Email Lark của bạn cần nằm trong bảng pic_members mới được ghi chú.',
        };
      }
      const note = String(args.note || '').trim();
      if (!note) return { error: 'Nội dung ghi chú đang trống.' };

      const { match, candidates } = await resolveProject(args.query);
      if (!match) return candidateError(candidates);
      const nodeCode = String(args.node_code || '').trim().toUpperCase();
      const node = await getProjectNode(match.id, nodeCode);
      if (!node) return { error: `Dự án ${match.code} không có bước ${nodeCode}.` };

      // Phân quyền GIỐNG update_node: chủ bước (tên mình trong PIC) hoặc trưởng phòng của bước.
      const owners = toPicArray(node.pic);
      const nodeDept = (node.dept || '').trim();
      const isLeaderOfDept =
        Array.isArray(ctx.leadDepts) && nodeDept && ctx.leadDepts.includes(nodeDept);
      const isOwner = owners.includes((ctx.picName || '').trim());
      if (!isLeaderOfDept && !isOwner) {
        return {
          error: `Bước ${nodeCode} do "${picText(node.pic) || 'chưa gán'}" (phòng ${nodeDept || '—'}) phụ trách. Bạn chỉ ghi chú được bước của mình hoặc bước thuộc phòng bạn quản lý.`,
        };
      }

      // Nối thêm dòng ghi chú kèm ngày + người ghi (không xoá cũ).
      const now = new Date();
      const stamp = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`;
      const who = ctx.picName || 'PIC';
      const line = `[${stamp} - ${who}] ${note}`;
      const prev = (node.notes || '').trim();
      const merged = prev ? `${prev}\n${line}` : line;

      const updated = await updateProjectNode(match.id, nodeCode, { notes: merged });
      return {
        ok: true,
        project: match.code,
        node: nodeCode,
        note_added: line,
        notes: updated.notes,
      };
    },
  },

  ask_pics: {
    declaration: {
      name: 'ask_pics',
      description:
        'Gửi hộ 1 tin nhắn/câu hỏi tới các PIC qua Lark DM. Bot tự chèn dòng ghi rõ người gửi. PIC thường: chỉ gửi được cho PIC CÙNG PHÒNG (mặc định cả phòng, hoặc 1 người qua pic_name). TRƯỞNG PHÒNG: gửi được cho TẤT CẢ PIC, hoặc giới hạn theo 1 phòng (dept) / 1 PIC (pic_name). LUÔN tóm tắt nội dung + danh sách người nhận và HỎI XÁC NHẬN trước khi gửi.',
      parameters: {
        type: 'OBJECT',
        properties: {
          message: { type: 'STRING', description: 'nội dung tin nhắn/câu hỏi cần gửi' },
          dept: {
            type: 'STRING',
            description:
              'chỉ gửi cho PIC của 1 phòng cụ thể (tùy chọn; chỉ trưởng phòng dùng được — PIC thường luôn bị giới hạn trong phòng của mình)',
          },
          pic_name: {
            type: 'STRING',
            description: 'chỉ gửi cho 1 PIC cụ thể (tùy chọn)',
          },
        },
        required: ['message'],
      },
    },
    async execute(args, ctx) {
      const leadDepts = Array.isArray(ctx.leadDepts) ? ctx.leadDepts : [];
      const isLeader = leadDepts.length > 0;
      if (!ctx.authed) {
        return {
          error:
            'Chức năng gửi tin cho PIC chỉ dành cho PIC (email/Lark của bạn phải có trong pic_members).',
        };
      }
      if (!isLeader && !ctx.dept) {
        return {
          error: 'Bạn chưa được gán phòng trong pic_members nên chưa xác định được người nhận cùng phòng.',
        };
      }
      if (!isLarkConfigured) {
        return { error: 'Lark chưa được cấu hình nên không gửi được tin.' };
      }
      const message = String(args.message || '').trim();
      if (!message) return { error: 'Nội dung tin nhắn đang trống.' };

      // PIC thường chỉ gửi trong phòng mình; trưởng phòng gửi được phòng bất kỳ.
      const scopeDept = isLeader ? args.dept : ctx.dept;
      if (!isLeader && args.dept && norm(args.dept) !== norm(ctx.dept)) {
        return {
          error: `Bạn chỉ nhờ bot gửi được cho PIC CÙNG PHÒNG (${ctx.dept}). Muốn gửi cho phòng "${args.dept}" thì cần trưởng phòng.`,
        };
      }

      const all = await listAllMembers();
      const myName = norm(ctx.picName);
      // Người nhận: mọi PIC có liên hệ Lark, trừ chính người gửi.
      let recipients = all.filter(
        (m) => (m.open_id || m.email) && norm(m.pic_name) !== myName,
      );

      // Giới hạn theo phòng (nếu có).
      if (scopeDept) {
        const d = norm(scopeDept);
        recipients = recipients.filter((m) => norm(m.dept) === d);
        if (recipients.length === 0) {
          return { error: `Không có PIC nào khác (có liên hệ Lark) thuộc phòng "${scopeDept}".` };
        }
      }

      // Giới hạn theo 1 PIC cụ thể (nếu có).
      if (args.pic_name) {
        const want = norm(args.pic_name);
        recipients = recipients.filter(
          (m) => norm(m.pic_name).includes(want) || want.includes(norm(m.pic_name)),
        );
        if (recipients.length === 0) {
          return {
            error: isLeader
              ? `Không tìm thấy PIC "${args.pic_name}" (có liên hệ Lark) để gửi.`
              : `Không tìm thấy PIC "${args.pic_name}" (có liên hệ Lark) trong phòng ${ctx.dept} của bạn.`,
          };
        }
      }

      if (recipients.length === 0) {
        return { error: 'Không có PIC nào có liên hệ Lark để gửi.' };
      }

      const senderRole = isLeader ? `Trưởng phòng ${leadDepts.join(', ')}` : `phòng ${ctx.dept}`;
      const senderLine = `— Người gửi: ${ctx.picName || 'PIC'} (${senderRole})`;
      const title = isLeader ? '💬 Tin nhắn từ trưởng phòng' : '💬 Tin nhắn từ đồng nghiệp';
      const text = `${title} – Feelex QLDA\n\n${message}\n\n${senderLine}`;

      const sent = [];
      const failed = [];
      for (const m of recipients) {
        const r = await dmContact(m, text);
        if (r.ok) sent.push({ pic: m.pic_name, dept: m.dept, via: r.via });
        else failed.push({ pic: m.pic_name, dept: m.dept, err: r.err });
      }

      return {
        ok: sent.length > 0,
        sender: ctx.picName || null,
        scope: args.pic_name
          ? `PIC ${args.pic_name}`
          : scopeDept
            ? `phòng ${scopeDept}`
            : 'tất cả PIC',
        sent_count: sent.length,
        sent,
        failed_count: failed.length,
        failed: failed.length ? failed : undefined,
        message_sent: text,
      };
    },
  },
};

function getDeclarations() {
  return Object.values(tools).map((t) => t.declaration);
}

async function executeTool(name, args, ctx) {
  const tool = tools[name];
  if (!tool) return { error: `Tool không tồn tại: ${name}` };
  try {
    return await tool.execute(args || {}, ctx || {});
  } catch (err) {
    return { error: `Lỗi khi chạy ${name}: ${err.message || String(err)}` };
  }
}

module.exports = { tools, getDeclarations, executeTool, STATUS_OPTIONS };
