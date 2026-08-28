import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache, openStudentProfileModal, studentThumbHtml } from "./students.js";
import { computeLongTermAbsentees, ALERT_THRESHOLD } from "./absentee.js";
import { buildAttendanceDetail } from "./report.js";
import { $, escapeHtml, nearestSundayISO, friendlyFirestoreError } from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";

export async function initDashboardView() {
  const classes = await loadClasses();
  await loadStudents(true); // 항상 최신 데이터로 새로고침 (다른 화면/탭에서 방금 삭제한 내용이 바로 반영되도록)
  const visible = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));
  const visibleIds = visible.map(c => c.id);
  const students = getStudentsCache().filter(s => visibleIds.includes(s.classId));

  const date = nearestSundayISO();
  const { details } = await buildAttendanceDetail(date);
  const visibleRows = details.filter(d => visibleIds.includes(d.classId));
  // 2026-08-23: 새친구는 더 이상 학년반 소속 + 상태값으로만 구분하지 않고, 별도의 새친구반(newcomer)에서
  // 관리하며 공식 재적 인원/출석 합계에는 포함하지 않는다(재적으로 전환되면 그때부터 포함됨).
  // 새친구반 자체의 인원/출석은 아래에서 별도로 계산해 참고용으로 보여준다.
  const regularRows = visibleRows.filter(r => r.classId !== "newcomer");
  const newcomerRow = visibleRows.find(r => r.classId === "newcomer");
  const rowsTotal = regularRows.reduce((acc, r) => ({ roster: acc.roster + r.roster, present: acc.present + r.present }), { roster: 0, present: 0 });

  const activeCount = students.filter(s => s.status === "active").length;
  const newCount = students.filter(s => s.status === "new").length;
  const holdCount = students.filter(s => s.status === "hold").length;

  $("#dashboardCards").innerHTML = `
    <div class="stat-card">
      <div class="label">전체 재적 인원</div><div class="value">${activeCount}</div>
    </div>
    <div class="stat-card"><div class="label">새친구</div><div class="value">${newCount}</div></div>
    <div class="stat-card"><div class="label">보류</div><div class="value">${holdCount}</div></div>
    <div class="stat-card">
      <div class="label">이번 주(${date}) 출석</div><div class="value">${rowsTotal.present} / ${rowsTotal.roster}</div>
      ${newcomerRow ? `<div class="stat-sub">(새친구반 별도 출석 ${newcomerRow.present} / ${newcomerRow.roster})</div>` : ""}
    </div>
    <div class="stat-card"><div class="label">이번 주 출석률</div><div class="value">${rowsTotal.roster ? Math.round((rowsTotal.present / rowsTotal.roster) * 1000) / 10 : 0}%</div></div>
  `;

  const { results: absentees, indexError } = await computeLongTermAbsentees(visibleIds);
  const absenteeWrap = $("#absenteeList");
  if (indexError) {
    absenteeWrap.innerHTML = `<p class="list empty" style="color:#e03131;line-height:1.6;">${friendlyFirestoreError(indexError)}</p>`;
  } else if (!absentees.length) {
    absenteeWrap.innerHTML = `<p class="list empty">${ALERT_THRESHOLD}주 이상 연속 결석한 학생이 없습니다. 👍</p>`;
  } else {
    absenteeWrap.innerHTML = absentees.map(a => `
      <div class="list-item">
        <span class="student-name-cell">
          ${studentThumbHtml(a)}
          <a href="#" class="student-name-link" data-student-id="${a.studentId}">${escapeHtml(a.name)}</a>
          <span style="color:#868e96;">(${escapeHtml(a.className)})</span>
        </span>
        <span class="badge badge-x">${a.weeks}주 연속 결석</span>
      </div>
    `).join("");
    // 이름을 누르면 재적부와 동일한 학생 프로필 모달(사진/연락처/보호자 등)이 뜸
    absenteeWrap.querySelectorAll(".student-name-link").forEach(link => {
      link.onclick = (e) => {
        e.preventDefault();
        const id = e.currentTarget.dataset.studentId;
        const student = getStudentsCache().find(s => s.id === id);
        if (student) openStudentProfileModal(student);
      };
    });
  }

  // 새친구반도 이제 다른 반들과 동일하게 반별 출석 현황 표에 나열한다(2026-08-23부터 실제 반으로 운영).
  // "그 중 새친구" 열은, 아직 정리되지 않고 학년반에 남아있는(과거 방식으로 등록된) 새친구 학생을
  // 찾기 위한 참고용 열이라 새친구반 자기 자신의 줄에서는 의미가 없으므로 "-"로 표시한다.
  const weekWrap = $("#dashboardWeekTable");
  weekWrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>반</th><th>재적</th><th>출석</th><th>출석률</th><th>그 중 새친구</th></tr></thead>
      <tbody>
        ${visibleRows.map(r => `
          <tr><td>${escapeHtml(r.className)}</td><td>${r.roster}</td><td>${r.present}</td>
          <td>${r.roster ? Math.round((r.present / r.roster) * 1000) / 10 : 0}%</td>
          <td class="dim-note">${r.classId === "newcomer" ? "-" : (r.newRoster ? `${r.newRoster}명 (출석 ${r.newPresent})` : "-")}</td></tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;
}
