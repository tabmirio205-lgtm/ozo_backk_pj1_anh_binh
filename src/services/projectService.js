const fs = require('node:fs/promises');
const path = require('node:path');
const { getSupabaseClient } = require('../config/supabaseClient');
const { WORKFLOW_NODES, NODE_INDEX } = require('../constants/workflowNodes');
const { leaderLabel } = require('./picMembersService');
const { toPicArray } = require('../utils/pic');
const { computeAllDates, isoLocal } = require('../utils/datePlanner');

// Baseline "ngày dự kiến": tính kế hoạch gốc từ start_date + duration + after,
// BỎ QUA ngày thực tế (để mốc không trôi khi các bước hoàn thành sớm/muộn).
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

// Insert/upsert node kèm planned_date; nếu DB chưa có cột thì bỏ cột đó rồi thử lại
// (để chạy được cả trước khi chạy sql/planned-date.sql).
async function writeNodes(supabase, rows, { upsert = false } = {}) {
  const run = (data) =>
    upsert
      ? supabase.from('project_nodes').upsert(data, { onConflict: 'project_id,node_id' })
      : supabase.from('project_nodes').insert(data);
  let { error } = await run(rows);
  // DB có thể chưa có cột planned_date và/hoặc name (chạy trước sql migration tương ứng)
  // -> bỏ cột thiếu rồi thử lại, để không chặn ghi node.
  for (const col of ['planned_date', 'name']) {
    if (error && new RegExp(col, 'i').test(error.message || '')) {
      rows = rows.map(({ [col]: _omit, ...rest }) => rest);
      ({ error } = await run(rows));
    }
  }
  if (error) throw error;
}

async function ensureMasterNodes() {
  const supabase = getSupabaseClient();
  const rows = WORKFLOW_NODES.map((node) => ({
    code: node.code,
    stage: node.stage,
    name: node.name,
    dept: node.dept,
    default_duration: node.defaultDuration,
    default_after: node.defaultAfter,
  }));

  const { error } = await supabase
    .from('master_nodes')
    .upsert(rows, { onConflict: 'code' });

  if (error) throw error;
}

async function listProjects() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('projects')
    .select('id,code,name,type,category,product_group,owner,start_date')
    .order('start_date', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function getProjectDetail(projectId) {
  const supabase = getSupabaseClient();
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .single();
  if (projectError) throw projectError;

  const { data: nodes, error: nodesError } = await supabase
    .from('project_nodes')
    .select('*')
    .eq('project_id', projectId)
    .order('node_id', { ascending: true });
  if (nodesError) throw nodesError;
  const { data: masterNodes, error: masterError } = await supabase
    .from('master_nodes')
    .select('code,name,stage')
    .order('code', { ascending: true });
  if (masterError) throw masterError;

  const masterMap = Object.fromEntries((masterNodes ?? []).map((item) => [item.code, item]));
  const mergedNodes = (nodes ?? []).map((node) => ({
    ...node,
    // Tên lấy TÊN RIÊNG lưu trên node trước (để dự án cũ giữ bố cục cũ dù master đổi),
    // rồi mới fallback về master dùng chung.
    node_name: node.name || masterMap[node.node_id]?.name || node.node_id,
    stage: masterMap[node.node_id]?.stage || node.node_id.charAt(0),
  }));

  return { project, nodes: mergedNodes };
}

async function getProjectNode(projectId, nodeId) {
  const supabase = getSupabaseClient();
  // Cần cả `dept` để kiểm quyền TRƯỞNG PHÒNG (isLeaderOfDept) ở web & chatbot,
  // và `status` để dùng khi cần. Thiếu dept -> leader luôn bị coi là không phải leader.
  const { data, error } = await supabase
    .from('project_nodes')
    .select('pic,dept,status')
    .eq('project_id', projectId)
    .eq('node_id', nodeId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function updateProjectNode(projectId, nodeId, payload) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('project_nodes')
    .update(payload)
    .eq('project_id', projectId)
    .eq('node_id', nodeId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// Khi 1 bước hoàn tất -> các bước kế tiếp (successor trực tiếp) đủ điều kiện thì
// tự chuyển 'Chưa làm' -> 'Đang làm'. "Đủ điều kiện" = mọi bước phụ thuộc (after)
// đã 'Đã xong' hoặc 'Bỏ qua'. Trả về danh sách node_id vừa được mở.
const SATISFIED_DEP = new Set(['Đã xong', 'Bỏ qua']);

// Trả về danh sách node_id các bước phụ thuộc (after) CHƯA 'Đã xong'/'Bỏ qua'.
// Rỗng = đủ điều kiện để tích 'Đã xong'. Bỏ qua dep trỏ tới bước không tồn tại.
async function getUnsatisfiedDeps(projectId, nodeId) {
  const supabase = getSupabaseClient();
  const { data: nodes, error } = await supabase
    .from('project_nodes')
    .select('node_id,status,after')
    .eq('project_id', projectId);
  if (error) throw error;
  const byId = new Map((nodes || []).map((n) => [n.node_id, n]));
  const self = byId.get(nodeId);
  const deps = self && Array.isArray(self.after) ? self.after : [];
  return deps.filter((d) => {
    const dep = byId.get(d);
    return dep && !SATISFIED_DEP.has(dep.status);
  });
}
async function startReadySuccessors(projectId, completedNodeId) {
  const supabase = getSupabaseClient();
  const { data: nodes, error } = await supabase
    .from('project_nodes')
    .select('node_id,status,after')
    .eq('project_id', projectId);
  if (error) throw error;

  const byId = new Map((nodes || []).map((n) => [n.node_id, n]));
  const toStart = [];
  for (const n of nodes || []) {
    if (n.status !== 'Chưa làm') continue;
    const deps = Array.isArray(n.after) ? n.after : [];
    if (!deps.includes(completedNodeId)) continue; // chỉ bước phụ thuộc trực tiếp
    const allDone = deps.every((d) => {
      const dep = byId.get(d);
      return !dep || SATISFIED_DEP.has(dep.status);
    });
    if (allDone) toStart.push(n.node_id);
  }

  for (const nid of toStart) {
    await supabase
      .from('project_nodes')
      .update({ status: 'Đang làm' })
      .eq('project_id', projectId)
      .eq('node_id', nid);
  }
  return toStart;
}

// Nghịch đảo startReadySuccessors: khi 1 bước RỜI trạng thái hoàn tất
// ('Đã xong'/'Bỏ qua' -> 'Đang làm'/'Chưa làm'/'Tạm dừng'), mọi bước phụ thuộc nó
// (trực tiếp & gián tiếp) đang ở trạng thái đã mở khoá/hoàn tất phải quay về
// 'Chưa làm' và xoá ngày thực tế. 'Bỏ qua' được giữ nguyên (bỏ qua có chủ đích).
// Trả về danh sách node_id vừa bị đưa về 'Chưa làm'.
const REVERTABLE = new Set(['Đang làm', 'Đã xong', 'Tạm dừng']);
async function revertDependentsToNotStarted(projectId, changedNodeId) {
  const supabase = getSupabaseClient();
  const { data: nodes, error } = await supabase
    .from('project_nodes')
    .select('node_id,status,after')
    .eq('project_id', projectId);
  if (error) throw error;

  const byId = new Map((nodes || []).map((n) => [n.node_id, n]));
  // successorsOf[id] = các bước phụ thuộc trực tiếp vào id.
  const successorsOf = new Map();
  for (const n of nodes || []) {
    const deps = Array.isArray(n.after) ? n.after : [];
    for (const d of deps) {
      if (!successorsOf.has(d)) successorsOf.set(d, []);
      successorsOf.get(d).push(n.node_id);
    }
  }

  const reverted = [];
  const visited = new Set();
  const queue = [changedNodeId];
  while (queue.length) {
    const cur = queue.shift();
    for (const sid of successorsOf.get(cur) || []) {
      if (visited.has(sid)) continue;
      const s = byId.get(sid);
      if (!s || !REVERTABLE.has(s.status)) continue; // 'Chưa làm'/'Bỏ qua' -> để yên
      const deps = Array.isArray(s.after) ? s.after : [];
      const hasUnsatisfied = deps.some((d) => {
        const dep = byId.get(d);
        return dep && !SATISFIED_DEP.has(dep.status);
      });
      if (!hasUnsatisfied) continue; // mọi dep còn thoả -> không đụng
      visited.add(sid);
      reverted.push(sid);
      s.status = 'Chưa làm'; // cập nhật trong bộ nhớ để cascade tính đúng
      queue.push(sid);
    }
  }

  for (const nid of reverted) {
    await supabase
      .from('project_nodes')
      .update({ status: 'Chưa làm', actual_date: null })
      .eq('project_id', projectId)
      .eq('node_id', nid);
  }
  return reverted;
}

async function listProjectsWithNodes() {
  const supabase = getSupabaseClient();

  const { data: projects, error: projectsError } = await supabase
    .from('projects')
    .select('id,code,name,type,category,product_group,owner,start_date')
    .order('start_date', { ascending: true });
  if (projectsError) throw projectsError;

  const ids = (projects ?? []).map((p) => p.id);
  if (ids.length === 0) return [];

  const { data: nodes, error: nodesError } = await supabase
    .from('project_nodes')
    .select('*')
    .in('project_id', ids)
    .order('project_id', { ascending: true })
    .order('node_id', { ascending: true });
  if (nodesError) throw nodesError;

  const { data: masterNodes, error: masterError } = await supabase
    .from('master_nodes')
    .select('code,name,stage')
    .order('code', { ascending: true });
  if (masterError) throw masterError;

  const masterMap = Object.fromEntries(
    (masterNodes ?? []).map((item) => [item.code, item]),
  );

  const nodesByProjectId = new Map();
  for (const node of nodes ?? []) {
    const enriched = {
      ...node,
      // Ưu tiên tên riêng của node (dự án cũ giữ nguyên), fallback master dùng chung.
      node_name: node.name || masterMap[node.node_id]?.name || node.node_id,
      stage: masterMap[node.node_id]?.stage || node.node_id.charAt(0),
    };
    if (!nodesByProjectId.has(node.project_id)) nodesByProjectId.set(node.project_id, []);
    nodesByProjectId.get(node.project_id).push(enriched);
  }

  return (projects ?? []).map((p) => ({
    project: p,
    nodes: nodesByProjectId.get(p.id) ?? [],
  }));
}

async function createProject(payload) {
  const supabase = getSupabaseClient();

  await ensureMasterNodes();

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .insert([payload])
    .select('*')
    .single();
  if (projectError) throw projectError;

  // Seed thẳng từ WORKFLOW_NODES (nguồn chuẩn của quy trình), KHÔNG đọc master:
  // đảm bảo dự án mới đúng bố cục hiện tại và không dính node cũ còn sót trong master.
  // Lưu luôn TÊN RIÊNG vào node để về sau đổi quy trình không ảnh hưởng dự án cũ.
  const rows = WORKFLOW_NODES.map((n) => ({
    project_id: project.id,
    node_id: n.code,
    name: n.name,
    status: 'Chưa làm',
    // PIC là MẢNG (text[]). Mặc định = [nhãn trưởng phòng] nếu bước có phòng.
    pic: n.dept ? [leaderLabel(n.dept)] : [],
    duration: n.defaultDuration,
    actual_date: null,
    notes: '',
    dept: n.dept,
    after: n.defaultAfter || [],
    attachments: [],
  }));

  if (rows.length) {
    // Chốt mốc ngày dự kiến cố định ngay lúc tạo dự án.
    const plannedMap = baselinePlannedDates(project, rows);
    for (const r of rows) r.planned_date = plannedMap[r.node_id] || null;
    await writeNodes(supabase, rows);
  }

  return project;
}

// Nhân bản 1 dự án: tạo dự án mới (mã + tên mới) và COPY TOÀN BỘ các bước của
// dự án nguồn — giữ nguyên PIC, số ngày, trạng thái, ngày thực tế, phòng, sau
// bước, ghi chú, đính kèm, mốc ngày dự kiến. Trả về dự án mới.
async function copyProject(sourceProjectId, { code, name }) {
  const supabase = getSupabaseClient();
  const { project, nodes } = await getProjectDetail(sourceProjectId);
  if (!project) throw new Error('Không tìm thấy dự án nguồn');

  const { data: created, error: pErr } = await supabase
    .from('projects')
    .insert([
      {
        code,
        name,
        type: project.type,
        category: project.category || null,
        product_group: project.product_group || null,
        owner: project.owner || null,
        start_date: project.start_date,
      },
    ])
    .select('*')
    .single();
  if (pErr) throw pErr;

  const rows = (nodes || []).map((n) => ({
    project_id: created.id,
    node_id: n.node_id,
    // Giữ TÊN RIÊNG của dự án nguồn (node_name = tên đã hiển thị/đã lưu).
    name: n.name || n.node_name || null,
    status: n.status,
    pic: toPicArray(n.pic),
    duration: n.duration,
    actual_date: n.actual_date || null,
    notes: n.notes || '',
    dept: n.dept || null,
    after: Array.isArray(n.after) ? n.after : [],
    attachments: Array.isArray(n.attachments) ? n.attachments : [],
    planned_date: n.planned_date || null,
  }));
  if (rows.length) await writeNodes(supabase, rows);

  return created;
}

async function updateProject(projectId, payload) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('projects')
    .update(payload)
    .eq('id', projectId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function deleteProject(projectId) {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('projects').delete().eq('id', projectId);
  if (error) throw error;
  return { ok: true };
}

async function upsertProjectFromJsonRow(projectJson) {
  const supabase = getSupabaseClient();

  const projectPayload = {
    code: projectJson.id,
    name: projectJson.name,
    type: projectJson.type,
    category: projectJson.category || null,
    product_group: projectJson.group || null,
    owner: projectJson.owner || null,
    start_date: projectJson.startDate,
  };

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .upsert([projectPayload], { onConflict: 'code' })
    .select('*')
    .single();
  if (projectError) throw projectError;

  const nodes = Object.entries(projectJson.nodes || {}).map(([nodeId, nodeData]) => {
    const nodeMeta = NODE_INDEX[nodeId];
    return {
      project_id: project.id,
      node_id: nodeId,
      name: nodeData.name || nodeMeta?.name || nodeId,
      status: nodeData.status || 'Chua lam',
      pic: toPicArray(nodeData.pic),
      duration:
        typeof nodeData.duration === 'number'
          ? nodeData.duration
          : nodeMeta?.defaultDuration || 1,
      actual_date: nodeData.actualDate || null,
      notes: nodeData.notes || '',
      dept: nodeData.dept || nodeMeta?.dept || null,
      after: Array.isArray(nodeData.after) ? nodeData.after : nodeMeta?.defaultAfter || [],
      attachments: Array.isArray(nodeData.attachments) ? nodeData.attachments : [],
    };
  });

  if (nodes.length > 0) {
    const plannedMap = baselinePlannedDates(project, nodes);
    for (const n of nodes) n.planned_date = plannedMap[n.node_id] || null;
    await writeNodes(supabase, nodes, { upsert: true });
  }

  return project;
}

async function seedFromJsonFile(jsonFilePath) {
  const fullPath = path.resolve(jsonFilePath);
  const content = await fs.readFile(fullPath, 'utf8');
  const parsed = JSON.parse(content);
  const projects = parsed.projects || [];

  await ensureMasterNodes();
  for (const project of projects) {
    await upsertProjectFromJsonRow(project);
  }

  return { total: projects.length, path: fullPath };
}

async function seedFromPayload(projects) {
  const safeProjects = Array.isArray(projects) ? projects : [];
  await ensureMasterNodes();
  for (const project of safeProjects) {
    await upsertProjectFromJsonRow(project);
  }
  return { total: safeProjects.length };
}

module.exports = {
  ensureMasterNodes,
  listProjects,
  listProjectsWithNodes,
  getProjectDetail,
  createProject,
  copyProject,
  updateProject,
  deleteProject,
  getProjectNode,
  updateProjectNode,
  startReadySuccessors,
  revertDependentsToNotStarted,
  getUnsatisfiedDeps,
  seedFromJsonFile,
  seedFromPayload,
};

