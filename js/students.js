import {
  db, collection, getDocs, addDoc, updateDoc, deleteDoc, doc, query, orderBy, serverTimestamp
} from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import {
  $, escapeHtml, STUDENT_STATUS_LABEL, openModal, closeModal, todayISO, parseDelimitedLine
} from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";
import { addHistoryRecord } from "./history.js";

let _studentsCache = [];

export async function loadStudents(force = false) {
  if (_studentsCache.length && !force) return _studentsCache;
  const q = query(collection(db, "students"), orderBy("order"));
  const snap = await getDocs(q);
  _studentsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _studentsCache;
}

export function getStudentsCache() {
  return _studentsCache;
}

export async function initStudentsView() {
  const classes = await loadClasses();
  const visibleClasses = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));

  const classFilter = $("#studentsClassFilter");
  classFilter.innerHTML = `<option value="all">전체 반</option>` +
    visibleClasses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  $("#studentsClassFilter").onchange = renderStudentsTable;
  $("#studentsStatusFilter").onchange = renderStudentsTable;
  $("#addStudentBtn").onclick = () => openStudentModal();
  $("#bulkImportBtn").onclick = () => openBulkImportModal(visibleClasses);

  await loadStudents(true);
  renderStudentsTable();
}


async function renderStudentsTable() {
  const classId = $("#studentsClassFilter").value;
  const status = $("#studentsStatusFilter").value;
  const classes = getClassesCache();
  const classMap = Object.fromEntries(classes.map(c => [c.id, c.name]));
  const allowed = isAdmin() ? null : new Set(currentUser.classIds);

  let list = _studentsCache.filter(s => {
    if (allowed && !allowed.has(s.classId)) return false;
    if (classId !== "all" && s.classId !== classId) return false;
    if (status !== "all" && s.status !== status) return false;
    return true;
  });

  const wrap = $("#studentsTableWrap");
  if (!list.length) {
    wrap.innerHTML = `<div class="panel"><p class="list empty">표시할 학생이 없습니다.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr>
        <th>이름</th><th>반</th><th>성별</th><th>상태</th><th>등록일</th><th>비고</th><th></th>
      </tr></thead>
      <tbody>
        ${list.map(s => `
          <tr data-id="${s.id}">
            <td>${escapeHtml(s.name)}</td>
            <td>${escapeHtml(classMap[s.classId] || s.classId)}</td>
            <td>${s.gender === "F" ? "여" : "남"}</td>
            <td><span class="badge badge-${s.status}">${STUDENT_STATUS_LABEL[s.status] || s.status}</span></td>
            <td>${escapeHtml(s.joinDate || "")}</td>
            <td>${escapeHtml(s.note || "")}</td>
            <td><button class="btn btn-sm editStudentBtn">수정</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;

  wrap.querySelectorAll(".editStudentBtn").forEach(btn => {
    btn.onclick = (e) => {
      const id = e.target.closest("tr").dataset.id;
      const student = _studentsCache.find(s => s.id === id);
      openStudentModal(student);
    };
  });
}

function openStudentModal(student = null) {
  const classes = getClassesCache();
  const visible = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));
  const isEdit = !!student;

  openModal(`
    <h3>${isEdit ? "학생 정보 수정" : "학생 추가"}</h3>
    <label>이름</label>
    <input id="f_name" value="${escapeHtml(student?.name || "")}" />
    <label>반</label>
    <select id="f_classId">
      ${visible.map(c => `<option value="${c.id}" ${student?.classId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
    </select>
    <label>성별</label>
    <select id="f_gender">
      <option value="M" ${student?.gender === "M" ? "selected" : ""}>남</option>
      <option value="F" ${student?.gender === "F" ? "selected" : ""}>여</option>
    </select>
    <label>상태</label>
    <select id="f_status">
      <option value="active" ${student?.status === "active" ? "selected" : ""}>재적</option>
      <option value="new" ${student?.status === "new" ? "selected" : ""}>새친구</option>
      <option value="leave" ${student?.status === "leave" ? "selected" : ""}>휴학</option>
      <option value="transferred_out" ${student?.status === "transferred_out" ? "selected" : ""}>전출</option>
      <option value="removed" ${student?.status === "removed" ? "selected" : ""}>제적</option>
    </select>
    <label>등록일</label>
    <input type="date" id="f_joinDate" value="${student?.joinDate || todayISO()}" />
    <label>비고</label>
    <textarea id="f_note" rows="2">${escapeHtml(student?.note || "")}</textarea>
    <div class="modal-actions">
      ${isEdit ? `<button id="deleteBtn" class="btn btn-danger">삭제</button>` : ""}
      <button id="cancelBtn" class="btn">취소</button>
      <button id="saveBtn" class="btn btn-primary">저장</button>
    </div>
  `);

  $("#cancelBtn").onclick = closeModal;

  if (isEdit) {
    $("#deleteBtn").onclick = async () => {
      if (!confirm(`${student.name} 학생 정보를 삭제할까요? (출석 기록은 유지됩니다)`)) return;
      await deleteDoc(doc(db, "students", student.id));
      await loadStudents(true);
      closeModal();
      renderStudentsTable();
    };
  }

  $("#saveBtn").onclick = async () => {
    const payload = {
      name: $("#f_name").value.trim(),
      classId: $("#f_classId").value,
      gender: $("#f_gender").value,
      status: $("#f_status").value,
      joinDate: $("#f_joinDate").value,
      note: $("#f_note").value.trim(),
      order: student?.order ?? Date.now()
    };
    if (!payload.name) { alert("이름을 입력해주세요."); return; }

    if (isEdit) {
      const prevStatus = student.status;
      await updateDoc(doc(db, "students", student.id), payload);
      if (prevStatus !== payload.status) {
        await addHistoryRecord({
          studentId: student.id, studentName: payload.name, classId: payload.classId,
          type: payload.status, date: todayISO(), note: `상태 변경: ${STUDENT_STATUS_LABEL[prevStatus]} → ${STUDENT_STATUS_LABEL[payload.status]}`
        });
      }
    } else {
      const ref = await addDoc(collection(db, "students"), { ...payload, createdAt: serverTimestamp() });
      await addHistoryRecord({
        studentId: ref.id, studentName: payload.name, classId: payload.classId,
        type: payload.status === "new" ? "new" : "transfer_in", date: payload.joinDate, note: "신규 등록"
      });
    }
    await loadStudents(true);
    closeModal();
    renderStudentsTable();
  };
}

function openBulkImportModal(visibleClasses) {
  openModal(`
    <h3>CSV 일괄 등록</h3>
    <p style="font-size:13px;color:#6b7280;">
      한 줄에 학생 한 명씩, <code>이름,반이름,성별(남/여)</code> 형식으로 붙여넣어주세요.<br/>
      구글시트에서 이름/반/성별 열을 복사해서 그대로 붙여넣어도 됩니다. (쉼표 또는 탭 구분 모두 지원)<br/>
      예) <code>정현우,중1,남</code>
    </p>
    <label>반 이름 매핑 참고</label>
    <p style="font-size:12px;color:#868e96;">${visibleClasses.map(c => c.name).join(", ")}</p>
    <textarea id="csvInput" rows="10" placeholder="정현우,중1,남&#10;안다은,중1,여"></textarea>
    <div class="modal-actions">
      <button id="cancelBtn" class="btn">취소</button>
      <button id="importBtn" class="btn btn-primary">등록</button>
    </div>
    <p id="importMsg" style="font-size:13px;margin-top:8px;"></p>
  `);

  $("#cancelBtn").onclick = closeModal;
  $("#importBtn").onclick = async () => {
    const text = $("#csvInput").value.trim();
    if (!text) return;
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const nameToClassId = Object.fromEntries(visibleClasses.map(c => [c.name, c.id]));
    let success = 0, fail = 0;

    for (const line of lines) {
      const parts = parseDelimitedLine(line).map(p => p.trim());
      const [name, className, genderRaw] = parts;
      const classId = nameToClassId[className];
      if (!name || !classId) { fail++; continue; }
      const gender = (genderRaw === "여" || genderRaw === "F") ? "F" : "M";
      await addDoc(collection(db, "students"), {
        name, classId, gender, status: "active", joinDate: todayISO(), note: "",
        order: Date.now() + success, createdAt: serverTimestamp()
      });
      success++;
    }
    $("#importMsg").textContent = `${success}명 등록 완료${fail ? `, ${fail}건 실패(반 이름 확인 필요)` : ""}`;
    await loadStudents(true);
    renderStudentsTable();
  };
}
