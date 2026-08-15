import {
  db, collection, addDoc, getDocs, query, orderBy, serverTimestamp
} from "./firebase-init.js";
import { $, escapeHtml, HISTORY_TYPE_LABEL, openModal, closeModal, todayISO } from "./utils.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { getClassesCache, loadClasses } from "./classes.js";
import { currentUser } from "./auth.js";

export async function addHistoryRecord({ studentId, studentName, classId, type, date, note }) {
  await addDoc(collection(db, "rosterHistory"), {
    studentId, studentName, classId, type, date: date || todayISO(),
    note: note || "", createdBy: currentUser.uid, createdAt: serverTimestamp()
  });
}

async function loadHistory() {
  const q = query(collection(db, "rosterHistory"), orderBy("date", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function initHistoryView() {
  await loadClasses();
  await loadStudents();
  $("#addHistoryBtn").onclick = openAddHistoryModal;
  await renderHistoryTable();
}

async function renderHistoryTable() {
  const classMap = Object.fromEntries(getClassesCache().map(c => [c.id, c.name]));
  const records = await loadHistory();
  const wrap = $("#historyTableWrap");

  if (!records.length) {
    wrap.innerHTML = `<div class="panel"><p class="list empty">등록된 변동 이력이 없습니다.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>날짜</th><th>이름</th><th>반</th><th>구분</th><th>비고</th></tr></thead>
      <tbody>
        ${records.map(r => `
          <tr>
            <td>${escapeHtml(r.date)}</td>
            <td>${escapeHtml(r.studentName)}</td>
            <td>${escapeHtml(classMap[r.classId] || r.classId || "")}</td>
            <td>${HISTORY_TYPE_LABEL[r.type] || r.type}</td>
            <td>${escapeHtml(r.note || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;
}

function openAddHistoryModal() {
  const students = getStudentsCache();
  const classMap = Object.fromEntries(getClassesCache().map(c => [c.id, c.name]));

  openModal(`
    <h3>재적 변동 기록 추가</h3>
    <label>학생</label>
    <select id="f_student">
      ${students.map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(classMap[s.classId] || "")})</option>`).join("")}
    </select>
    <label>구분</label>
    <select id="f_type">
      <option value="new">새친구 등록</option>
      <option value="transfer_in">전입</option>
      <option value="transfer_out">전출</option>
      <option value="leave">휴학</option>
      <option value="return">복학/복귀</option>
      <option value="removed">제적</option>
    </select>
    <label>날짜</label>
    <input type="date" id="f_date" value="${todayISO()}" />
    <label>비고</label>
    <textarea id="f_note" rows="2"></textarea>
    <div class="modal-actions">
      <button id="cancelBtn" class="btn">취소</button>
      <button id="saveBtn" class="btn btn-primary">저장</button>
    </div>
  `);

  $("#cancelBtn").onclick = closeModal;
  $("#saveBtn").onclick = async () => {
    const studentId = $("#f_student").value;
    const student = students.find(s => s.id === studentId);
    if (!student) return;
    await addHistoryRecord({
      studentId, studentName: student.name, classId: student.classId,
      type: $("#f_type").value, date: $("#f_date").value, note: $("#f_note").value.trim()
    });
    closeModal();
    renderHistoryTable();
  };
}
