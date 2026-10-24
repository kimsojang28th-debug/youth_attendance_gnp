import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache, openStudentProfileModal, studentThumbHtml } from "./students.js";
import {
  $, escapeHtml, nearestSundayISO, sortByName, toast,
  yearSelectOptionsHtml, sundayOptionsHtmlForYear, getSundaysOfYear
} from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";
import { rosterForYear } from "./terms.js";

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
  await loadClasses();
  // 담당 교사가 못 나온 날 다른 교사가 대신 진행하는 경우가 많아서, 출석은 모든 교사가 모든 반에서 입력할 수 있음
  // 반 목록은 선택한 연도(학년도)의 편성을 따른다 (지난 해 기록을 고칠 때는 그해의 반이 나옴)
  const select = $("#attendanceClassSelect");
  const fillClassOptions = async (year) => {
    const roster = await rosterForYear(year);
    select.innerHTML = roster.classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    return roster.classes;
  };
  const visible = await fillClassOptions(new Date().getFullYear());
  // 마지막으로 출석체크한 반을 기억해서 다음에 열 때 자동 선택 (담당 교사는 매주 같은 반을 고르기 때문)
  // 날짜는 기억하지 않음 - 기본값(가장 가까운 주일)이 이미 "이번 주"이고, 기억하면 지난 주가 열릴 위험이 있음
  try {
    const last = localStorage.getItem("youth:lastAttendanceClass");
    const has = (id) => id && select.querySelector(`option[value="${id}"]`);
    // 마지막으로 체크한 반 -> 없으면 내 담당반 -> 없으면 첫 번째 반
    const pick = has(last) ? last : currentUser.classIds.find(has);
    if (pick) select.value = pick;
  } catch (e) { /* 저장소를 못 쓰는 환경이면 무시 */ }

  // 연도를 먼저 고르고 그 연도의 주일만 보이도록 함 (기본값: 올해)
  const thisYear = new Date().getFullYear();
  const yearSelect = $("#attendanceYearSelect");
  yearSelect.innerHTML = yearSelectOptionsHtml(thisYear);

  const dateSelect = $("#attendanceDate");
  dateSelect.innerHTML = sundayOptionsHtmlForYear(thisYear, nearestSundayISO());

  yearSelect.onchange = async () => {
    const year = Number(yearSelect.value);
    const defaultDate = year === new Date().getFullYear() ? nearestSundayISO() : getSundaysOfYear(year)[0];
    dateSelect.innerHTML = sundayOptionsHtmlForYear(year, defaultDate);
    await fillClassOptions(year);
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
  try { localStorage.setItem("youth:lastAttendanceClass", classId); } catch (e) { /* 무시 */ }

  // "제적"/"졸업" 상태만 출석체크 명단에서 제외 (재적/새친구/보류 학생은 모두 출석체크 대상에 포함)
  // 2026-08-23(5차): "졸업" 상태 추가 — 졸업한 학생은 청년부로 넘어간 것이므로 제적 학생과 마찬가지로
  // 청소년부 출석체크 대상에서 제외함.
  // 2026-08-23(4차): 선택한 날짜 시점에 아직 등록(joinDate)되지 않았던 학생은 출석체크 대상에서
  // 제외함 — 안 그러면 그 반의 다른 학생 출석을 체크하고 저장할 때, 아직 등록 전이었던 학생도
  // 화면에 함께 표시되다가 기본값 "X"로 같이 저장되어 버리는 문제가 있었음(등록일이 서로 다른
  // 학생이 섞이기 쉬운 새친구반에서 특히 두드러짐 — 나중에 합류한 친구가 합류 전 주차에도
  // "결석"으로 기록되고 그 주 주간보고서에까지 나타나버림). joinDate가 비어있는(예: 예전 데이터)
  // 학생은 안전하게 예전처럼 항상 포함함(필터링하지 않음).
  const roster = await rosterForYear(Number(date.slice(0, 4)));
  const students = sortByName(
    roster.students.filter(s =>
      s.classId === classId && s.status !== "removed" && s.status !== "graduated" &&
      (!s.joinDate || s.joinDate <= date)
    )
  );
  const existing = await getAttendanceDoc(classId, date);
  const studentIdSet = new Set(students.map(s => s.id));
  // 기존에 저장돼있던 기록 중에도, 위 필터에 걸리는(그 날짜엔 아직 등록 전이었던) 학생의 기록은
  // 걸러내고 불러옴 — 이렇게 하면 이미 잘못 저장된 기록도 이 화면을 다시 열고 그냥 저장만 눌러도
  // 자동으로 정리됨(수동 삭제나 재입력이 필요 없음).
  _currentRecords = {};
  if (existing?.records) {
    Object.entries(existing.records).forEach(([sid, val]) => {
      if (studentIdSet.has(sid)) _currentRecords[sid] = val;
    });
  }
  _currentNotes = {};
  if (existing?.notes) {
    Object.entries(existing.notes).forEach(([sid, val]) => {
      if (studentIdSet.has(sid)) _currentNotes[sid] = val;
    });
  }
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
              <td><span class="student-name-cell">${studentThumbHtml(s)}<a href="#" class="student-name-link" data-student-id="${s.id}">${escapeHtml(s.name)}</a></span></td>
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

  // 이름을 누르면 재적부와 동일한 학생 프로필 모달(사진/연락처/보호자 등)이 뜸
  wrap.querySelectorAll(".student-name-link").forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      const id = e.currentTarget.dataset.studentId;
      const student = getStudentsCache().find(s => s.id === id);
      if (student) openStudentProfileModal(student);
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
