import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { $, escapeHtml, nearestSundayISO, toast } from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";

export function attendanceDocId(classId, date) {
  return `${classId}_${date}`;
}

export async function getAttendanceDoc(classId, date) {
  const snap = await getDoc(doc(db, "attendance", attendanceDocId(classId, date)));
  return snap.exists() ? snap.data() : null;
}

export async function saveAttendanceDoc(classId, date, records) {
  await setDoc(doc(db, "attendance", attendanceDocId(classId, date)), {
    classId, date, records, checkedBy: currentUser.uid, checkedAt: serverTimestamp()
  });
}

let _currentRecords = {};

export async function initAttendanceView() {
  const classes = await loadClasses();
  const visible = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));
  const select = $("#attendanceClassSelect");
  select.innerHTML = visible.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  const dateInput = $("#attendanceDate");
  if (!dateInput.value) dateInput.value = nearestSundayISO();

  $("#loadAttendanceBtn").onclick = renderAttendanceTable;
  $("#saveAttendanceBtn").onclick = handleSaveAttendance;

  await loadStudents();
  if (visible.length) await renderAttendanceTable();
}

async function renderAttendanceTable() {
  const classId = $("#attendanceClassSelect").value;
  const date = $("#attendanceDate").value;
  if (!classId || !date) return;

  const students = getStudentsCache().filter(s => s.classId === classId && s.status !== "removed" && s.status !== "transferred_out");
  const existing = await getAttendanceDoc(classId, date);
  _currentRecords = existing?.records ? { ...existing.records } : {};

  const wrap = $("#attendanceTableWrap");
  if (!students.length) {
    wrap.innerHTML = `<div class="panel"><p class="list empty">이 반에 등록된 재적 학생이 없습니다. 먼저 재적부에 학생을 등록해주세요.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>이름</th><th>상태</th><th>출석</th></tr></thead>
      <tbody>
        ${students.map(s => {
          const val = _currentRecords[s.id] || "X";
          return `
            <tr data-id="${s.id}">
              <td>${escapeHtml(s.name)}</td>
              <td>${s.status === "new" ? "새친구" : s.status === "leave" ? "휴학" : "재적"}</td>
              <td class="att-cell att-${val === "O" ? "o" : "x"}" data-val="${val}">${val}</td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>
    </div>
    <p style="font-size:12.5px;color:#868e96;margin-top:8px;">출석 셀을 클릭하면 O/X가 전환됩니다.</p>
  `;

  wrap.querySelectorAll(".att-cell").forEach(cell => {
    cell.onclick = () => {
      const tr = cell.closest("tr");
      const id = tr.dataset.id;
      const newVal = cell.dataset.val === "O" ? "X" : "O";
      cell.dataset.val = newVal;
      cell.textContent = newVal;
      cell.className = `att-cell att-${newVal === "O" ? "o" : "x"}`;
      _currentRecords[id] = newVal;
    };
  });
}

async function handleSaveAttendance() {
  const classId = $("#attendanceClassSelect").value;
  const date = $("#attendanceDate").value;
  if (!classId || !date) return;
  await saveAttendanceDoc(classId, date, _currentRecords);
  toast(`${date} 출석이 저장되었습니다.`, $("#attendanceSaveMsg"));
}
