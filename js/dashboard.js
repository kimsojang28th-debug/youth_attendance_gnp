import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache, openStudentProfileModal, studentThumbHtml } from "./students.js";
import { computeLongTermAbsentees, ALERT_THRESHOLD } from "./absentee.js";
import { buildAttendanceDetail } from "./report.js";
import { $, escapeHtml, nearestSundayISO, friendlyFirestoreError } from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";
import { goToAttendance } from "./app.js";
import { db, doc, getDoc } from "./firebase-init.js";
import { loadTeachers } from "./teachers.js";
import { initDashboardCalendar } from "./calendar.js";
import { rosterForYear, getTransitionNotice } from "./terms.js";

export async function initDashboardView() {
  const classes = await loadClasses();
  await loadStudents(true); // 항상 최신 데이터로 새로고침 (다른 화면/탭에서 방금 삭제한 내용이 바로 반영되도록)
  // 캘린더는 나머지 대시보드 내용과 따로(동시에) 불러와서, 어느 한쪽이 느리거나 실패해도 다른 쪽에 영향을 주지 않게 함
  const calendarReady = initDashboardCalendar().catch(err => console.error("캘린더 로딩 실패", err));
  const date = nearestSundayISO();
  // 새해 전환 직후(1/1~첫 주일 전)에는 "가장 가까운 지난 주일"이 지난 학년도에 속하므로, 그 날짜의 학년도 명부를 기준으로 함
  const roster = await rosterForYear(Number(date.slice(0, 4)));
  const visible = roster.classes; // 대리 진행이 많아 모든 교사가 전체 반을 봄
  const visibleIds = visible.map(c => c.id);
  const students = roster.students.filter(s => visibleIds.includes(s.classId));

  const { details } = await buildAttendanceDetail(date);
  const visibleRows = details.filter(d => visibleIds.includes(d.classId));
  // 2026-08-23: 새친구는 더 이상 학년반 소속 + 상태값으로만 구분하지 않고, 별도의 새친구반(newcomer)에서
  // 관리하며 공식 재적 인원/출석 합계에는 포함하지 않는다(재적으로 전환되면 그때부터 포함됨).
  // 새친구반 자체의 인원/출석은 아래에서 별도로 계산해 참고용으로 보여준다.
  await renderTodo(date, visibleRows);

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
  // 예전에는 마지막 열에 "그 중 새친구"(학년반에 남아있는 과거 방식 새친구 학생 수)를 보여줬으나,
  // 새친구를 별도 새친구반으로 완전히 분리한 뒤로는 이 열에 표시할 내용이 없어져서, 대신 각 반의
  // 담당 선생님 이름을 보여주도록 변경함.
  const teacherNamesByClassId = Object.fromEntries(
    visible.map(c => [c.id, (c.teacherNames && c.teacherNames.length) ? c.teacherNames.join(", ") : "미배정"])
  );

  const weekWrap = $("#dashboardWeekTable");
  weekWrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr><th>반</th><th>재적</th><th>출석</th><th>출석률</th><th>담당 선생님</th></tr></thead>
      <tbody>
        ${visibleRows.map(r => `
          <tr>
            <td><a href="#" class="class-name-link" data-class-id="${r.classId}">${escapeHtml(r.className)}</a></td>
            <td>${r.roster}</td><td>${r.present}</td>
            <td>${r.roster ? Math.round((r.present / r.roster) * 1000) / 10 : 0}%</td>
            <td class="dim-note">${escapeHtml(teacherNamesByClassId[r.classId] || "미배정")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;

  // 반 이름을 누르면 출석체크 화면으로 이동하면서 그 반과 이번 주 날짜가 자동으로 선택됨
  weekWrap.querySelectorAll(".class-name-link").forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      goToAttendance(e.currentTarget.dataset.classId, date);
    };
  });

  await calendarReady;
}

// "이번 주 할 일" - 매주 반복되는 순서(출석체크 → 예배정보 입력 → 주간보고서)를 큰 버튼으로 보여주고,
// 이번 주 입력 상태를 배지로 표시해서 아직 안 한 일이 한눈에 보이게 함.
async function renderTodo(date, visibleRows) {
  let meta = {};
  try {
    const snap = await getDoc(doc(db, "weeklyMeta", date));
    if (snap.exists()) meta = snap.data();
  } catch (err) { console.warn("예배정보 상태 확인 실패", err); }

  // 재적 인원이 0명인 반은 출석체크할 필요가 없으므로 제외
  const targets = visibleRows.filter(r => r.roster > 0);
  const checked = targets.filter(r => r.checked).length;
  let attBadge;
  if (!targets.length) attBadge = `<span class="badge badge-removed">대상 반 없음</span>`;
  else if (checked === targets.length) attBadge = `<span class="badge badge-active">✔ 입력 완료 (${checked}/${targets.length}반)</span>`;
  else if (checked === 0) attBadge = `<span class="badge badge-hold">미입력 (0/${targets.length}반)</span>`;
  else attBadge = `<span class="badge badge-hold">입력 중 (${checked}/${targets.length}반)</span>`;

  const offering = meta.offering || {};
  const worshipDone = !!(meta.sermonTitle || meta.sermonText || meta.preacher ||
    Object.values(offering).some(v => Number(v) > 0));
  const worshipBadge = worshipDone
    ? `<span class="badge badge-active">✔ 입력 완료</span>`
    : `<span class="badge badge-hold">미입력</span>`;

  // 관리자에게만: 비밀번호 재설정을 요청한 교사가 있으면 알림
  let resetCount = 0;
  if (isAdmin()) {
    try { resetCount = (await loadTeachers(true)).filter(t => t.uid && t.resetRequested).length; }
    catch (err) { console.warn("재설정 요청 확인 실패", err); }
  }
  // 관리자에게만: 연말(12/20~)이거나 새해가 됐는데 아직 새 학년도로 전환하지 않았으면 안내
  let termAlert = "";
  if (isAdmin()) {
    try {
      const n = await getTransitionNotice();
      if (n) {
        termAlert = `<a href="#newyear" class="todo-alert">📅 ${n.hasDraft
          ? `<b>${n.nextYear} 학년도 편성이 준비되어 있습니다.</b> ${n.started ? "지금 전환할 수 있습니다." : "12월 마지막 주일 출석을 입력한 뒤 전환하세요."}`
          : `<b>${n.nextYear} 학년도 편성이 아직 준비되지 않았습니다.</b>`}
          <span>새 학년도 편성 열기 ›</span></a>`;
      }
    } catch (err) { console.warn("학년도 전환 안내 확인 실패", err); }
  }
  const resetAlert = resetCount
    ? `<a href="#teachers" class="todo-alert">🔑 비밀번호 재설정 요청이 <b>${resetCount}건</b> 있습니다. <span>교사현황에서 초기화하기 ›</span></a>`
    : "";

  $("#dashboardTodo").innerHTML = `
    ${termAlert}${resetAlert}
    <div class="todo-head"><h3>이번 주 할 일</h3><span class="dim-note">${date} 주일 기준</span></div>
    <div class="todo-grid">
      <a href="#attendance" class="todo-card">
        <span class="todo-top"><span class="todo-step">1</span><span class="todo-title">✅ 출석체크</span></span>
        <span class="todo-desc">반별 출석을 체크하고 저장합니다.</span>${attBadge}
      </a>
      <a href="#worship" class="todo-card">
        <span class="todo-top"><span class="todo-step">2</span><span class="todo-title">🎵 예배정보 입력</span></span>
        <span class="todo-desc">설교·헌금·심방 내용을 입력합니다.</span>${worshipBadge}
      </a>
      <a href="#report" class="todo-card">
        <span class="todo-top"><span class="todo-step">3</span><span class="todo-title">📝 주간보고서 보기</span></span>
        <span class="todo-desc">입력한 결과를 확인하고 A4로 인쇄합니다.</span>
      </a>
    </div>
  `;
}
