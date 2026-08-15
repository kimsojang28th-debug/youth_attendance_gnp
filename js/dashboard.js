import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { computeLongTermAbsentees, ALERT_THRESHOLD } from "./absentee.js";
import { buildAttendanceDetail } from "./report.js";
import { $, escapeHtml, nearestSundayISO } from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";

export async function initDashboardView() {
  const classes = await loadClasses();
  await loadStudents();
  const visible = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));
  const visibleIds = visible.map(c => c.id);
  const students = getStudentsCache().filter(s => visibleIds.includes(s.classId));

  const date = nearestSundayISO();
  const { details } = await buildAttendanceDetail(date);
  const visibleRows = details.filter(d => visibleIds.includes(d.classId));
  const rowsTotal = visibleRows.reduce((acc, r) => ({ roster: acc.roster + r.roster, present: acc.present + r.present }), { roster: 0, present: 0 });

  const activeCount = students.filter(s => s.status === "active").length;
  const newCount = students.filter(s => s.status === "new").length;
  const leaveCount = students.filter(s => s.status === "leave").length;

  $("#dashboardCards").innerHTML = `
    <div class="stat-card"><div class="label">전체 재적 인원</div><div class="value">${activeCount + newCount}</div></div>
    <div class="stat-card"><div class="label">새친구</div><div class="value">${newCount}</div></div>
    <div class="stat-card"><div class="label">휴학</div><div class="value">${leaveCount}</div></div>
    <div class="stat-card"><div class="label">이번 주(${date}) 출석</div><div class="value">${rowsTotal.present} / ${rowsTotal.roster}</div></div>
    <div class="stat-card"><div class="label">이번 주 출석률</div><div class="value">${rowsTotal.roster ? Math.round((rowsTotal.present / rowsTotal.roster) * 1000) / 10 : 0}%</div></div>
  `;

  const absentees = await computeLongTermAbsentees(visibleIds);
  const absenteeWrap = $("#absenteeList");
  if (!absentees.length) {
    absenteeWrap.innerHTML = `<p class="list empty">${ALERT_THRESHOLD}주 이상 연속 결석한 학생이 없습니다. 👍</p>`;
  } else {
    absenteeWrap.innerHTML = absentees.map(a => `
      <div class="list-item">
        <span>${escapeHtml(a.name)} <span style="color:#868e96;">(${escapeHtml(a.className)})</span></span>
        <span class="badge badge-x">${a.weeks}주 연속 결석</span>
      </div>
    `).join("");
  }

  const weekWrap = $("#dashboardWeekTable");
  weekWrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>반</th><th>재적</th><th>출석</th><th>출석률</th></tr></thead>
      <tbody>
        ${visibleRows.map(r => `
          <tr><td>${escapeHtml(r.className)}</td><td>${r.roster}</td><td>${r.present}</td>
          <td>${r.roster ? Math.round((r.present / r.roster) * 1000) / 10 : 0}%</td></tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;
}
