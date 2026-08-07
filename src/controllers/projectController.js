const {
      PROJECT_STATUSES,
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
} = require("../services/projectService");
const { findMemberByName } = require("../services/picMembersService");
const { toPicArray } = require("../utils/pic");
const { todayIsoVN } = require("../utils/datePlanner");
const {
      notifyAssignment,
      notifyNewProjectAssignments,
      notifyStepsStarted,
      notifyStepCompleted,
      snapshotDueDates,
      notifyDueDateChanges,
      affectsDueDates,
} = require("../services/reminders/reminderService");

async function getProjects(req, res) {
      const data = await listProjects();
      res.json(data);
}

async function getProjectById(req, res) {
      const projectId = Number(req.params.projectId);
      const data = await getProjectDetail(projectId);
      res.json(data);
}

async function getProjectsWithNodes(req, res) {
      const data = await listProjectsWithNodes();
      res.json(data);
}

async function postProject(req, res) {
      const { code, name, type, category, product_group, owner, start_date } =
            req.body || {};
      if (!code || !name || !type || !start_date) {
            return res
                  .status(400)
                  .json({ error: "code, name, type, start_date là bắt buộc" });
      }

      const created = await createProject({
            code,
            name,
            type,
            category: category || null,
            product_group: product_group || null,
            owner: owner || null,
            start_date,
      });

      // Tạo xong -> gửi tin GIAO VIỆC cho từng người phụ trách (nhãn "Trưởng phòng
      // X" quy về trưởng phòng thật). Chạy nền, không chặn phản hồi.
      notifyNewProjectAssignments(created.id).catch((e) =>
            console.error("[new-project-notify] lỗi:", e.message),
      );

      res.status(201).json(created);
}

async function copyProjectController(req, res) {
      const sourceId = Number(req.params.projectId);
      const code = String(req.body?.code || "").trim();
      const name = String(req.body?.name || "").trim();
      if (!code || !name) {
            return res
                  .status(400)
                  .json({ error: "Mã và tên dự án mới là bắt buộc" });
      }
      try {
            const created = await copyProject(sourceId, { code, name });
            return res.status(201).json(created);
      } catch (e) {
            if (/duplicate|unique/i.test(e.message || "")) {
                  return res
                        .status(409)
                        .json({ error: `Mã dự án "${code}" đã tồn tại.` });
            }
            throw e;
      }
}

async function patchProject(req, res) {
      const projectId = Number(req.params.projectId);
      const payload = { ...(req.body || {}) };

      // Trạng thái dự án chỉ nhận 3 giá trị hợp lệ (route đã chặn: chỉ manager).
      if (payload.status !== undefined) {
            const status = String(payload.status || "").trim();
            if (!PROJECT_STATUSES.includes(status)) {
                  return res.status(400).json({
                        error: `Trạng thái dự án không hợp lệ. Chọn 1 trong: ${PROJECT_STATUSES.join(", ")}.`,
                  });
            }
            payload.status = status;
      }

      try {
            const updated = await updateProject(projectId, payload);
            res.json(updated);
      } catch (e) {
            // DB chưa chạy sql/project-status.sql -> báo rõ thay vì lỗi 500 khó hiểu.
            if (payload.status !== undefined && /status/i.test(e.message || "")) {
                  return res.status(400).json({
                        error: "DB chưa có cột trạng thái dự án. Chạy backend/sql/project-status.sql trong Supabase rồi thử lại.",
                  });
            }
            throw e;
      }
}

async function removeProject(req, res) {
      const projectId = Number(req.params.projectId);
      const result = await deleteProject(projectId);
      res.json(result);
}

async function patchProjectNode(req, res) {
      const projectId = Number(req.params.projectId);
      const nodeId = req.params.nodeId;
      const payload = req.body || {};

      const { role, picName, leadDepts } = req.user || {};
      // PIC là MẢNG. Chuẩn hoá payload.pic về mảng ngay (web gửi mảng; chatbot/
      // dữ liệu cũ có thể gửi chuỗi) để mọi xử lý bên dưới đồng nhất.
      if (payload.pic !== undefined) payload.pic = toPicArray(payload.pic);

      // Bước TRƯỚC khi sửa: dùng cho phân quyền, tự điền ngày thực tế, và biết
      // trạng thái có thực sự đổi hay không (đọc 1 lần, dùng lại bên dưới).
      const node = await getProjectNode(projectId, nodeId);
      if (!node) {
            return res.status(404).json({ error: "Không tìm thấy bước" });
      }

      // Quản lý sửa mọi bước. Trưởng phòng sửa mọi bước thuộc phòng mình quản lý.
      // PIC thường chỉ sửa bước có tên mình trong danh sách PIC. Viewer: cấm.
      if (role !== "manager") {
            if (role !== "PIC") {
                  return res
                        .status(403)
                        .json({ error: "Bạn không có quyền sửa" });
            }
            // Phòng / Số ngày / Sau bước: chỉ cấp quản lý (nhập mã) mới được sửa.
            // Loại khỏi payload (thay vì chặn cả request) để không phá luồng đổi PIC.
            // PIC chỉ chuyển trong cùng phòng nên 'dept' của bước không cần đổi.
            for (const f of ["dept", "duration", "after"]) delete payload[f];
            const owners = toPicArray(node.pic);
            const nodeDept = (node.dept || "").trim();
            const isLeaderOfDept =
                  Array.isArray(leadDepts) && nodeDept && leadDepts.includes(nodeDept);
            const isOwner = owners.includes((picName || "").trim());
            if (!isLeaderOfDept && !isOwner) {
                  return res.status(403).json({
                        error:
                              "Bạn chỉ được sửa bước của mình hoặc bước thuộc phòng bạn quản lý",
                  });
            }

            // NGÀY THỰC TẾ: PIC thường không bao giờ tự chọn — bấm 'Đã xong' thì
            // hệ thống tự điền ngày hôm nay (xem khối tự điền bên dưới). Trưởng
            // phòng của bước & quản lý vẫn sửa tay được để chỉnh sai sót.
            if (!isLeaderOfDept) delete payload.actual_date;

            // Bước đã 'Đã xong'/'Bỏ qua': PIC thường hết quyền sửa Ghi chú / Đính
            // kèm (chốt hồ sơ sau khi hoàn tất). Trưởng phòng của bước & quản lý
            // vẫn sửa được. Gửi lại y nguyên giá trị cũ thì bỏ qua im lặng (form
            // gửi kèm cả trường không đổi); mở lại bước trong cùng lần sửa thì
            // cho phép luôn.
            const LOCK_AFTER_DONE = ["notes", "attachments"];
            const nodeDone = ["Đã xong", "Bỏ qua"].includes(node.status);
            const reopening =
                  payload.status !== undefined &&
                  !["Đã xong", "Bỏ qua"].includes(payload.status);
            if (nodeDone && !isLeaderOfDept && !reopening) {
                  // Rỗng dưới mọi dạng (null / '' / []) coi như bằng nhau.
                  const norm = (v) =>
                        v === undefined || v === null || v === "" ||
                        (Array.isArray(v) && v.length === 0)
                              ? null
                              : v;
                  const same = (a, b) =>
                        JSON.stringify(norm(a)) === JSON.stringify(norm(b));
                  const changed = LOCK_AFTER_DONE.filter(
                        (f) => payload[f] !== undefined && !same(payload[f], node[f]),
                  );
                  if (changed.length) {
                        return res.status(403).json({
                              error:
                                    "Bước đã kết thúc — bạn không sửa được Ghi chú / Đính kèm nữa. Nhờ trưởng phòng, hoặc mở lại bước trước khi sửa.",
                        });
                  }
                  for (const f of LOCK_AFTER_DONE) delete payload[f];
            }

            // PIC-chủ-bước (không phải trưởng phòng) muốn ĐỔI danh sách PIC -> mọi
            // người MỚI phải CÙNG PHÒNG với bước (người đã có sẵn thì giữ nguyên).
            if (payload.pic !== undefined && !isLeaderOfDept) {
                  const cleaned = [];
                  for (const name of payload.pic) {
                        if (owners.includes(name)) {
                              cleaned.push(name);
                              continue;
                        }
                        const target = await findMemberByName(name);
                        if (!target) {
                              return res.status(400).json({
                                    error: `Không tìm thấy PIC "${name}" trong danh bạ.`,
                              });
                        }
                        const targetDept = (target.dept || "").trim();
                        if (!nodeDept || targetDept !== nodeDept) {
                              return res.status(403).json({
                                    error: `Chỉ được thêm PIC cùng phòng ${nodeDept || "—"}. "${target.pic_name}" thuộc phòng ${targetDept || "—"}.`,
                              });
                        }
                        cleaned.push(target.pic_name); // chuẩn hoá tên theo danh bạ
                  }
                  payload.pic = cleaned;
            }
      }

      // Chuẩn hoá từng tên PIC về đúng danh bạ (vd "Ly" -> "Phạm Khánh Ly") để
      // khớp nhắc việc/báo cáo, loại trùng. Không tìm thấy -> giữ nguyên (cho phép
      // người ngoài danh bạ). Nhãn vai trò "Trưởng phòng ..." giữ nguyên.
      if (payload.pic !== undefined) {
            const out = [];
            const seen = new Set();
            for (const raw of payload.pic) {
                  let name = raw;
                  if (!raw.startsWith("Trưởng phòng ")) {
                        const canon = await findMemberByName(raw);
                        if (canon) name = canon.pic_name;
                  }
                  const key = name.toLowerCase();
                  if (seen.has(key)) continue;
                  seen.add(key);
                  out.push(name);
            }
            payload.pic = out;
      }

      // Tự động: điền NGÀY THỰC TẾ mà không nêu trạng thái -> coi như 'Đã xong'.
      if (payload.actual_date && payload.status === undefined) {
            payload.status = "Đã xong";
      }

      // Ngược lại: bấm 'Đã xong' mà chưa có ngày thực tế -> tự điền HÔM NAY (giờ
      // VN). Đây là đường duy nhất PIC ghi ngày thực tế, vì ô ngày đã bị khoá.
      if (
            payload.status === "Đã xong" &&
            payload.actual_date === undefined &&
            !node.actual_date
      ) {
            payload.actual_date = todayIsoVN();
      }

      // MỞ LẠI bước đã xong (đổi sang trạng thái khác) mà không nêu ngày -> xoá
      // ngày thực tế cũ, để lần hoàn tất sau đóng dấu đúng ngày mới. (Cùng cách
      // xử lý với revertDependentsToNotStarted cho các bước phía sau.)
      if (
            payload.status !== undefined &&
            payload.status !== "Đã xong" &&
            node.status === "Đã xong" &&
            payload.actual_date === undefined &&
            node.actual_date
      ) {
            payload.actual_date = null;
      }

      // Chặn tích 'Đã xong' khi bước phụ thuộc (after) chưa 'Đã xong'/'Bỏ qua'.
      if (payload.status === "Đã xong") {
            const pending = await getUnsatisfiedDeps(projectId, nodeId);
            if (pending.length) {
                  return res.status(409).json({
                        error: `Chưa thể hoàn tất: bước phụ thuộc chưa xong/bỏ qua — ${pending.join(", ")}`,
                  });
            }
      }

      // Sau khi lọc quyền, nếu không còn gì để cập nhật -> trả về bước hiện tại.
      if (Object.keys(payload).length === 0) {
            const detail = await getProjectDetail(projectId);
            const current = detail.nodes.find((n) => n.node_id === nodeId);
            return res.json(current || {});
      }

      // Ngày dự kiến tính động theo cả chuỗi bước -> chụp ảnh TRƯỚC khi sửa để
      // sau đó biết bước nào bị dời ngày mà báo PIC. Chỉ chụp khi payload có thể
      // làm đổi ngày (khỏi tốn 1 lượt đọc cho các sửa đổi như PIC/ghi chú).
      const dueBefore = affectsDueDates(payload)
            ? await snapshotDueDates(projectId)
            : null;

      // Trạng thái có THỰC SỰ đổi trong lần sửa này không? Form sửa bước luôn gửi
      // kèm status dù người dùng chỉ thêm ghi chú/đính kèm, nên phải so với giá trị
      // cũ — nếu không, mỗi lần thêm ảnh vào bước đã xong lại chạy nhánh "vừa hoàn
      // tất" (chỉ nhờ dedupe sent_reminders mới không bắn tin trùng).
      const statusChanged =
            payload.status !== undefined && payload.status !== node.status;

      const data = await updateProjectNode(projectId, nodeId, payload);

      // Bước vừa 'Đã xong' hoặc 'Bỏ qua' -> mở khoá các bước kế tiếp đủ điều kiện sang 'Đang làm'.
      if (statusChanged && (data.status === "Đã xong" || data.status === "Bỏ qua")) {
            // (1) Báo TRƯỞNG PHÒNG của chính bước vừa xong/bỏ qua (Lark DM, chạy nền).
            notifyStepCompleted(projectId, nodeId, data.status).catch((e) =>
                  console.error("[done-notify] lỗi:", e.message),
            );
            // (2) Mở khoá bước kế tiếp + báo cho PIC bước kế tiếp (Lark DM, chạy nền).
            const started = await startReadySuccessors(projectId, nodeId);
            if (started && started.length) {
                  notifyStepsStarted(projectId, started).catch((e) =>
                        console.error("[start-notify] lỗi:", e.message),
                  );
            }
      } else if (statusChanged) {
            // Bước RỜI trạng thái hoàn tất (vd 'Đã xong' -> 'Đang làm') -> các bước
            // phụ thuộc nó quay về 'Chưa làm' (đệ quy xuống chuỗi).
            await revertDependentsToNotStarted(projectId, nodeId);
      }

      // Vừa phân/đổi PIC -> gửi ngay thông báo "việc mới được giao" cho PIC (Lark DM).
      // Chạy nền, không chặn phản hồi; dedupe & bỏ qua nhãn vai trò nằm trong service.
      // Bước RỜI 'Tạm dừng' về lại trạng thái đang mở cũng gửi: lúc đang Tạm dừng mọi
      // DM cho PIC bị chặn (xem SILENT trong reminderService), nên nếu PIC được phân
      // trong lúc đó thì đây là dịp gửi bù. Đã gửi rồi thì dedupe chặn lại.
      const resumedFromPause =
            statusChanged &&
            node.status === "Tạm dừng" &&
            data.status !== "Đã xong" &&
            data.status !== "Bỏ qua";
      if (payload.pic !== undefined || resumedFromPause) {
            notifyAssignment(projectId, nodeId).catch((e) =>
                  console.error("[assign-notify] lỗi:", e.message),
            );
      }

      // Báo PIC các bước bị DỜI NGÀY DỰ KIẾN. Chạy SAU cùng để ảnh so sánh gồm
      // cả tác động của startReadySuccessors/revertDependentsToNotStarted ở trên.
      if (dueBefore) {
            notifyDueDateChanges(projectId, dueBefore).catch((e) =>
                  console.error("[date-notify] lỗi:", e.message),
            );
      }

      res.json(data);
}

async function seedProjects(req, res) {
      const defaultPath = "o:/06-RnD/QuanLyDuAn/feelex-data.json";
      const targetPath =
            req.body?.jsonPath || process.env.SEED_JSON_PATH || defaultPath;
      const result = await seedFromJsonFile(targetPath);
      res.json({ ok: true, ...result });
}

async function seedProjectsFromPayload(req, res) {
      const payload = req.body || {};
      const projects = Array.isArray(payload.projects) ? payload.projects : [];
      const result = await seedFromPayload(projects);
      res.json({ ok: true, ...result });
}

module.exports = {
      getProjects,
      getProjectsWithNodes,
      getProjectById,
      postProject,
      copyProjectController,
      patchProject,
      removeProject,
      patchProjectNode,
      seedProjects,
      seedProjectsFromPayload,
};
