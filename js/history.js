import {
  db, collection, addDoc, getDocs, updateDoc, deleteDoc, doc, query, where, orderBy, serverTimestamp
} from "./firebase-init.js";
import { $, $all, escapeHtml, HISTORY_TYPE_LABEL, HISTORY_TYPE_OPTIONS, openModal, closeModal, todayISO } from "./utils.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { getClassesCache, loadClasses } from "./classes.js";
import { currentUser } from "./auth.js";

export async function addHistoryRecord({ studentId, studentName, classId, type, date, note }) {
  await addDoc(collection(db, "rosterHistory"), {
    studentId, studentName, classId, type, date: date || todayISO(),
    note: note || "", createdBy: currentUser.uid, createdAt: serverTimestamp()
  });
}

// 학생이 재적부에서 삭제될 때, 그 학생과 관련된 재적변동이력도 함께 정리하기 위한 헬퍼
export async function deleteHistoryForStudent(studentId) {
  const snap = await getDocs(query(collection(db, "rosterHistory"), where("studentId", "==", studentId)));
  for (const d of snap.docs) {
    await deleteDoc(doc(db, "rosterHistory", d.id));
  }
}

async function loadHistory() {
  const q = query(collection(db, "rosterHistory"), orderBy("date", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function initHistoryView() {
  await loadClasses();
  await loadStudents();
  $("#addHistoryBtn").onclick = () => openHistoryModal();
  $("#bulkDeleteHistoryBtn").onclick = handleBulkDelete;
  await renderHistoryTable();
}

async function renderHistoryTable() {
  const classMap = Object.fromEntries(getClassesCache().map(c => [c.id, c.name]));
  const records = await loadHistory();
  const wrap = $("#historyTableWrap");
  const bulkBtn = $("#bulkDeleteHistoryBtn");
  if (bulkBtn) bulkBtn.disabled = true;

  if (!records.length) {
    wrap.innerHTML = `<div class="panel"><p class="list empty">등록된 변동 이력이 없습니다.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr>
        <th><input type="checkbox" id="historySelectAll" /></th>
        <th>날짜</th><th>이름</th><th>반</th><th>구분</th><th>비고</th><th></th>
      </tr></thead>
      <tbody>
        ${records.map(r => `
          <tr data-id="${r.id}">
            <td><input type="checkbox" class="historyRowCheck" /></td>
            <td>${escapeHtml(r.date)}</td>
            <td>${escapeHtml(r.studentName)}</td>
            <td>${escapeHtml(classMap[r.classId] || r.classId || "")}</td>
            <td>${HISTORY_TYPE_LABEL[r.type] || r.type}</td>
            <td>${escapeHtml(r.note || "")}</td>
            <td style="white-space:nowrap;">
              <button class="btn btn-sm editHistoryBtn">수정</button>
              <button class="btn btn-sm btn-danger deleteHistoryBtn">삭제</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;

  const updateBulkBtnState = () => {
    const anyChecked = $all(".historyRowCheck").some(cb => cb.checked);
    if (bulkBtn) bulkBtn.disabled = !anyChecked;
  };

  $("#historySelectAll").onchange = (e) => {
    $all(".historyRowCheck").forEach(cb => { cb.checked = e.target.checked; });
    updateBulkBtnState();
  };
  $all(".historyRowCheck").forEach(cb => { cb.onchange = updateBulkBtnState; });

  wrap.querySelectorAll(".editHistoryBtn").forEach(btn => {
    btn.onclick = (e) => {
      const id = e.target.closest("tr").dataset.id;
      const record = records.find(r => r.id === id);
      openHistoryModal(record);
    };
  });

  wrap.querySelectorAll(".deleteHistoryBtn").forEach(btn => {
    btn.onclick = async (e) => {
      const tr = e.target.closest("tr");
      const id = tr.dataset.id;
      const record = records.find(r => r.id === id);
      if (!confirm(`"${record?.studentName || ""}"의 이 변동 기록을 삭제할까요?`)) return;
      await deleteDoc(doc(db, "rosterHistory", id));
      await renderHistoryTable();
    };
  });
}

async function handleBulkDelete() {
  const checkedRows = $all(".historyRowCheck:checked");
  if (!checkedRows.length) return;
  if (!confirm(`선택한 ${checkedRows.length}건의 변동 기록을 삭제할까요?`)) return;
  for (const cb of checkedRows) {
    const id = cb.closest("tr").dataset.id;
    await deleteDoc(doc(db, "rosterHistory", id));
  }
  await renderHistoryTable();
}

function openHistoryModal(record = null) {
  const students = getStudentsCache();
  const classMap = Object.fromEntries(getClassesCache().map(c => [c.id, c.name]));
  const isEdit = !!record;

  openModal(`
    <h3>${isEdit ? "재적 변동 기록 수정" : "재적 변동 기록 추가"}</h3>
    <label>학생</label>
    <select id="f_student">
      ${students.map(s => `<option value="${s.id}" ${record?.studentId === s.id ? "selected" : ""}>${escapeHtml(s.name)} (${escapeHtml(classMap[s.classId] || "")})</option>`).join("")}
    </select>
    <label>구분</label>
    <select id="f_type">
      ${
        // 과거에 저장된 기록의 구분이 지금은 선택 목록에서 빠진 옛날 값(전입/전출/휴학/복학·복귀)이면,
        // 목록 맨 앞에 그 값을 그대로 하나 더 넣어줘서 손대지 않고 저장해도 기존 값이 유지되게 함.
        (record?.type && !HISTORY_TYPE_OPTIONS.includes(record.type))
          ? `<option value="${record.type}" selected>${HISTORY_TYPE_LABEL[record.type] || record.type} (과거 값)</option>`
          : ""
      }
      ${HISTORY_TYPE_OPTIONS.map(type =>
        `<option value="${type}" ${record?.type === type ? "selected" : ""}>${HISTORY_TYPE_LABEL[type]}</option>`
      ).join("")}
    </select>
    <label>날짜</label>
    <input type="date" id="f_date" value="${record?.date || todayISO()}" />
    <label>비고</label>
    <textarea id="f_note" rows="2">${escapeHtml(record?.note || "")}</textarea>
    <div class="modal-actions">
      ${isEdit ? `<button id="deleteBtn" class="btn btn-danger">삭제</button>` : ""}
      <button id="cancelBtn" class="btn">취소</button>
      <button id="saveBtn" class="btn btn-primary">저장</button>
    </div>
  `);

  $("#cancelBtn").onclick = closeModal;

  if (isEdit) {
    $("#deleteBtn").onclick = async () => {
      if (!confirm(`"${record.studentName}"의 이 변동 기록을 삭제할까요?`)) return;
      await deleteDoc(doc(db, "rosterHistory", record.id));
      closeModal();
      renderHistoryTable();
    };
  }

  $("#saveBtn").onclick = async () => {
    const studentId = $("#f_student").value;
    const student = students.find(s => s.id === studentId);
    if (!student) return;
    const payload = {
      studentId, studentName: student.name,
      // 2026-08-23(5차): 변동 기록의 "반"은 그 사건이 일어난 시점의 스냅샷이어야 함. 기존에는
      // 수정 저장할 때마다 무조건 학생의 "현재" 반으로 덮어써버려서, 예전 기록(예: 새친구 등록 당시)이
      // 나중에 반이 바뀐 뒤 아무 내용이나 한 번 수정해서 저장하면 반 정보가 최신 반으로 바뀌어버리는
      // 문제가 있었음. 이제 수정 시에는 원래 저장돼있던 반을 그대로 유지하고, 새로 추가할 때만
      // 학생의 현재 반을 스냅샷으로 사용함.
      classId: isEdit ? record.classId : student.classId,
      type: $("#f_type").value, date: $("#f_date").value, note: $("#f_note").value.trim()
    };
    if (isEdit) {
      await updateDoc(doc(db, "rosterHistory", record.id), payload);
    } else {
      await addHistoryRecord(payload);
    }
    closeModal();
    renderHistoryTable();
  };
}

