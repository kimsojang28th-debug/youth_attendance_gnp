import { db, collection, getDocs, query, where } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache, openStudentProfileModal, studentThumbHtml } from "./students.js";
import { $, escapeHtml, getSundaysOfYear, fmtMonthDay, sortByName, friendlyFirestoreError, openModal, closeModal } from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";

// 학생 프로필 화면의 "출석현황" 버튼처럼, 다른 화면에서 "이 반의 연간출석부를 보여달라"고
// 미리 요청해둘 수 있게 하는 값. initAnnualView가 다음에 실행될 때 한 번만 사용되고 초기화됨.
let _pendingClassId = null;
export function requestAnnualClass(classId) {
  _pendingClassId = classId;
}

export async function initAnnualView() {
  const classes = await loadClasses();
  await loadStudents();
  const visible = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));

  const yearSelect = $("#annualYearSelect");
  const thisYear = new Date().getFullYear();
  yearSelect.innerHTML = [thisYear, thisYear - 1, thisYear + 1]
    .map(y => `<option value="${y}" ${y === thisYear ? "selected" : ""}>${y}년</option>`).join("");

  const classSelect = $("#annualClassSelect");
  classSelect.innerHTML = visible.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  // 다른 화면(학생 프로필의 "출석현황" 버튼 등)에서 특정 반을 미리 요청해뒀으면 그 반을 선택된 상태로 시작
  if (_pendingClassId && visible.some(c => c.id === _pendingClassId)) {
    classSelect.value = _pendingClassId;
  }
  _pendingClassId = null;

  yearSelect.onchange = renderAnnualTable;
  classSelect.onchange = renderAnnualTable;

  if (visible.length) await renderAnnualTable();
}

async function renderAnnualTable() {
  const year = Number($("#annualYearSelect").value);
  const classId = $("#annualClassSelect").value;
  if (!classId) return;

  const wrap = $("#annualTableWrap");
  wrap.innerHTML = `<p style="padding:16px;color:#868e96;">불러오는 중...</p>`;

  const sundays = getSundaysOfYear(year);
  const students = sortByName(getStudentsCache().filter(s => s.classId === classId && s.status !== "removed"));

  const q = query(
    collection(db, "attendance"),
    where("classId", "==", classId),
    where("date", ">=", `${year}-01-01`),
    where("date", "<=", `${year}-12-31`)
  );
  let snap;
  try {
    snap = await getDocs(q);
  } catch (err) {
    console.error("연간출석부 조회 실패", err);
    wrap.innerHTML = `<p class="list empty" style="padding:16px;line-height:1.6;color:#e03131;">${friendlyFirestoreError(err)}</p>`;
    return;
  }
  const byDate = {};
  const byDateNotes = {};
  const byDateExists = new Set(); // 그 날짜에 출석 기록 자체가 존재하는지 (미체크 학생을 "-" 대신 "X"로 보여주기 위함)
  snap.docs.forEach(d => {
    const data = d.data();
    byDate[data.date] = data.records || {};
    byDateNotes[data.date] = data.notes || {};
    byDateExists.add(data.date);
  });

  if (!students.length) {
    wrap.innerHTML = `<p class="list empty" style="padding:16px;">이 반에 등록된 학생이 없습니다.</p>`;
    return;
  }

  const rowsHtml = students.map(s => {
    let total = 0;
    const cells = sundays.map(date => {
      // 그 날짜에 출석 기록 자체는 있는데 이 학생 값만 없는 경우(과거 데이터에 있을 수 있음)는
      // 결석(X)으로 간주. 그 날짜에 출석 기록 자체가 아예 없으면(예배가 없었거나 아직 체크 안 함) "-".
      const rawVal = byDate[date]?.[s.id];
      const val = rawVal || (byDateExists.has(date) ? "X" : undefined);
      const note = byDateNotes[date]?.[s.id];
      const hasNote = !!(note && note.trim());
      if (val === "O") total++;
      const display = val || "-";
      const cls = val === "O" ? "att-o" : val === "X" ? "att-x" : "";
      const noteCls = hasNote ? "att-has-note" : "";
      const cursor = hasNote ? "cursor:pointer;" : "cursor:default;";
      return `<td class="att-cell ${cls} ${noteCls}" style="${cursor}" data-date="${date}" ${hasNote ? `data-note="${escapeHtml(note)}"` : ""}>${display}</td>`;
    }).join("");
    return `<tr><td><span class="student-name-cell">${studentThumbHtml(s)}<a href="#" class="student-name-link" data-student-id="${s.id}">${escapeHtml(s.name)}</a></span></td>${cells}<td style="font-weight:700;">${total}</td></tr>`;
  }).join("");

  const weeklyTotals = sundays.map(date => {
    const records = byDate[date] || {};
    return students.filter(s => records[s.id] === "O").length;
  });
  const grandTotal = weeklyTotals.reduce((a, b) => a + b, 0);

  wrap.innerHTML = `
    <table class="annual-table">
      <thead>
        <tr><th>이름</th>${sundays.map(d => `<th>${fmtMonthDay(d)}</th>`).join("")}<th>합계</th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr style="font-weight:700;"><td>주별 합계</td>${weeklyTotals.map(t => `<td>${t}</td>`).join("")}<td>${grandTotal}</td></tr>
      </tfoot>
    </table>
  `;

  wrap.querySelectorAll(".att-has-note").forEach(cell => {
    cell.onclick = () => {
      const tr = cell.closest("tr");
      const studentName = tr.querySelector("td:first-child").textContent;
      const date = cell.dataset.date;
      const note = cell.dataset.note || "";
      openModal(`
        <h3>출결 특이사항</h3>
        <p style="font-size:13px;color:#6b7280;margin:0 0 10px;">${escapeHtml(studentName)} · ${escapeHtml(date)}</p>
        <p style="white-space:pre-wrap;line-height:1.6;">${escapeHtml(note)}</p>
        <div class="modal-actions">
          <button id="cancelBtn" class="btn">닫기</button>
        </div>
      `);
      $("#cancelBtn").onclick = closeModal;
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
}
