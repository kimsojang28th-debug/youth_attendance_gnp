import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import {
  $, escapeHtml, nearestSundayISO, sortByName, toast,
  yearSelectOptionsHtml, sundayOptionsHtmlForYear, getSundaysOfYear
} from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";

export function attendanceDocId(classId, date) {
  return `${classId}_${date}`;
}

export async function getAttendanceDoc(classId, date) {
  const snap = await getDoc(doc(db, "attendance", attendanceDocId(classId, date)));
  return snap.exists() ? snap.data() : null;
}

export async function saveAttendanceDoc(classId, date, records, notes = {}) {
  await setDoc(doc(db, "attendance", attendanceDocId(classId, date)), {
    classId, date, records, notes, checkedBy: currentUser.uid, checkedAt: serverTimestamp()
  });
}

let _currentRecords = {};
let _currentNotes = {};
let _currentStudentCount = 0;

export async function initAttendanceView() {
  const classes = await loadClasses();
  const visible = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));
  const select = $("#attendanceClassSelect");
  select.innerHTML = visible.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  // 연도를 먼저 고르고 그 연도의 주일만 보이도록 함 (기본값: 올해)
  const thisYear = new Date().getFullYear();
  const yearSelect = $("#attendanceYearSelect");
  yearSelect.innerHTML = yearSelectOptionsHtml(thisYear);

  const dateSelect = $("#attendanceDate");
  dateSelect.innerHTML = sundayOptionsHtmlForYear(thisYear, nearestSundayISO());

  yearSelect.onchange = () => {
    const year = Number(yearSelect.value);
    const defaultDate = year === new Date().getFullYear() ? nearestSundayISO() : getSundaysOfYear(year)[0];
    dateSelect.innerHTML = sundayOptionsHtmlForYear(year, defaultDate);
  };

  $("#loadAttendanceBtn").onclick = renderAttendanceTable;
  $("#saveAttendanceBtn").onclick = handleSaveAttendance;

  await loadStudents();
  if (visible.length) await renderAttendanceTable();
}

async function renderAttendanceTable() {
  const classId = $("#attendanceClassSelect").value;
  const date = $("#attendanceDate").value;
  if (!classId || !date) return;

  // "제적" 상태만 출석체크 명단에서 제외 (재적/새친구/보류 학생은 모두 출석체크 대상에 포함)
  const students = sortByName(
    getStudentsCache().filter(s => s.classId === classId && s.status !== "removed")
  );
  const existing = await getAttendanceDoc(classId, date);
  _currentRecords = existing?.records ? { ...existing.records } : {};
  _currentNotes = existing?.notes ? { ...existing.notes } : {};
  // 화면에는 체크 안 한 학생이 기본값 "X"로 보이지만, 실제로 저장은 클릭해서 값이 바뀐
  // 학생만 되고 있었음 → 결석으로 둔(안 건드린) 학생은 records에 아예 기록이 안 남아서
  // 연간출석부 등에서 "X"가 아니라 "-"(기록없음)로 보이는 문제가 있었음.
  // 지금 반 재적 학생 전원에 대해 기본값을 명시적으로 채워서, 저장 시 항상 O/X가 남도록 함.
  students.forEach(s => {
    if (!(s.id in _currentRecords)) _currentRecords[s.id] = "X";
  });
  _currentStudentCount = students.length;

  const wrap = $("#attendanceTableWrap");
  if (!students.length) {
    wrap.innerHTML = `<div class="panel"><p class="list empty">이 반에 등록된 재적 학생이 없습니다. 먼저 재적부에 학생을 등록해주세요.</p></div>`;
    $("#attendanceSummaryLine").textContent = "";
    return;
  }

  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>이름</th><th>상태</th><th>출석</th><th>출결사유/특이사항</th></tr></thead>
      <tbody>
        ${students.map(s => {
          const val = _currentRecords[s.id] || "X";
          const note = _currentNotes[s.id] || "";
          return `
            <tr data-id="${s.id}">
              <td>${escapeHtml(s.name)}</td>
              <td>${s.status === "new" ? "새친구" : s.status === "hold" ? "보류" : "재적"}</td>
              <td class="att-cell att-${val === "O" ? "o" : "x"}" data-val="${val}">${val}</td>
              <td><input type="text" class="att-note-input" value="${escapeHtml(note)}" placeholder="예: 가족여행, 감기몸살 등" /></td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>
    </div>
    <p style="font-size:12.5px;color:#868e96;margin-top:8px;">출석 셀을 클릭하면 O/X가 전환됩니다. 결석 사유나 특이사항은 뒤 칸에 적어주세요.</p>
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
      updateSummaryLine();
    };
  });

  wrap.querySelectorAll(".att-note-input").forEach(input => {
    input.oninput = () => {
      const tr = input.closest("tr");
      const id = tr.dataset.id;
      _currentNotes[id] = input.value;
    };
  });

  updateSummaryLine();
}

function updateSummaryLine() {
  const present = Object.values(_currentRecords).filter(v => v === "O").length;
  const roster = _currentStudentCount;
  $("#attendanceSummaryLine").textContent = `재적 ${roster}명, 출석 ${present}명, 결석 ${roster - present}명`;
}

async function handleSaveAttendance() {
  const classId = $("#attendanceClassSelect").value;
  const date = $("#attendanceDate").value;
  if (!classId || !date) return;
  await saveAttendanceDoc(classId, date, _currentRecords, _currentNotes);
  toast(`${date} 출석이 저장되었습니다.`, $("#attendanceSaveMsg"));
}
