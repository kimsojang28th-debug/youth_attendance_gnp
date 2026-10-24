import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache, openStudentProfileModal } from "./students.js";
import { loadTeachers, getTeachersCache, openTeacherProfileModal } from "./teachers.js";
import { $, escapeHtml, sortByName, lunarMonthDay } from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";

// "월별 생일자" 화면: 달을 고르면 그 달에 생일인 학생(학년순 -> 가나다순)과 교사(날짜순)를 각각 따로 보여준다.
// 학생 생일은 students.js의 학생 추가/수정 폼에서 <input type="date">로 입력된 "YYYY-MM-DD" 형식만 저장되므로
// (2026-08-17부터), 문자열에서 바로 월/일을 뽑아 쓴다.
// 교사 생일은 음력일 수 있어서(교사 정보의 "음력" 선택), 음력 생일은 올해 양력으로 환산해서 해당 달에 해당하는 사람만 보여준다.

export async function initBirthdaysView() {
  await loadClasses();
  await loadStudents();
  await loadTeachers();

  const monthSelect = $("#birthdayMonthSelect");
  const thisMonth = new Date().getMonth() + 1;
  monthSelect.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1)
    .map(m => `<option value="${m}" ${m === thisMonth ? "selected" : ""}>${m}월</option>`).join("");

  monthSelect.onchange = renderBirthdayList;
  renderBirthdayList();
}

// 선택한 달에 생일인 교사 목록 [{ teacher, day, lunarLabel }] (날짜순)
function teachersWithBirthdayIn(month) {
  const year = new Date().getFullYear();
  const daysInMonth = new Date(year, month, 0).getDate();
  const result = [];
  getTeachersCache().forEach(t => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.birthday || "")) return;
    const bm = Number(t.birthday.slice(5, 7)), bd = Number(t.birthday.slice(8, 10));
    if (!t.lunar) {
      if (bm === month) result.push({ teacher: t, day: bd, lunarLabel: "" });
      return;
    }
    // 음력 생일: 선택한 달의 모든 날을 음력으로 바꿔 보고, 음력 월/일이 같은 날을 찾는다
    for (let d = 1; d <= daysInMonth; d++) {
      const l = lunarMonthDay(year, month - 1, d);
      if (l && l.m === bm && l.d === bd) { result.push({ teacher: t, day: d, lunarLabel: `음력 ${bm}/${bd}` }); break; }
    }
  });
  return result.sort((a, b) => a.day - b.day || (a.teacher.name || "").localeCompare(b.teacher.name || "", "ko"));
}

function renderBirthdayList() {
  const month = Number($("#birthdayMonthSelect").value);
  const wrap = $("#birthdayListWrap");
  if (!month) { wrap.innerHTML = ""; return; }

  const classes = getClassesCache();
  // 교사도 구분 없이 전체 학생 생일을 볼 수 있도록 함(합반/대체 교사 투입이 잦아서). 담당 반 필터는 사용하지 않음.
  // classes는 이미 Firestore에서 order 필드 기준으로 정렬되어 오므로(js/classes.js loadClasses),
  // 배열 안 위치를 그대로 "학년순" 정렬 기준으로 사용한다(재적부 등 다른 화면과 동일한 방식).
  const classOrder = Object.fromEntries(classes.map((c, idx) => [c.id, idx]));
  const classMap = Object.fromEntries(classes.map(c => [c.id, c.name]));

  const students = getStudentsCache().filter(s => {
    // 2026-08-23(5차): "졸업" 상태 추가 — 졸업한 학생은 청년부로 넘어간 것이므로 제적 학생과 마찬가지로
    // 청소년부 월별 생일자 명단에서 제외함.
    if (s.status === "removed" || s.status === "graduated") return false;
    if (!s.birthday || !/^\d{4}-\d{2}-\d{2}$/.test(s.birthday)) return false;
    return Number(s.birthday.split("-")[1]) === month;
  });

  const sorted = sortByName(students)
    .sort((a, b) => (classOrder[a.classId] ?? 999) - (classOrder[b.classId] ?? 999));
  const teachers = teachersWithBirthdayIn(month);

  const studentHtml = sorted.length ? `
    <div class="list">
      ${sorted.map(s => {
        const day = Number(s.birthday.split("-")[2]);
        return `
        <div class="list-item">
          <span class="student-name-cell">
            ${s.photoDataUrl
              ? `<img class="student-thumb" src="${s.photoDataUrl}" alt="" />`
              : `<span class="student-thumb student-thumb-placeholder">👤</span>`}
            <a href="#" class="student-name-link" data-student-id="${s.id}">${escapeHtml(s.name)}</a>
            <span style="color:#868e96;">(${escapeHtml(classMap[s.classId] || s.classId)})</span>
          </span>
          <span class="badge badge-birthday">🎂 ${month}월 ${day}일</span>
        </div>`;
      }).join("")}
    </div>` : `<p class="list empty">${month}월 생일인 학생이 없습니다.</p>`;

  const teacherHtml = teachers.length ? `
    <div class="list">
      ${teachers.map(({ teacher: t, day, lunarLabel }) => `
        <div class="list-item">
          <span class="student-name-cell">
            <span class="student-thumb student-thumb-placeholder">🧑‍🏫</span>
            <a href="#" class="student-name-link teacher-link" data-teacher-id="${t.id}">${escapeHtml(t.name)}</a>
            <span style="color:#868e96;">(교사${t.note ? ` · ${escapeHtml(t.note)}` : ""})</span>
          </span>
          <span class="badge badge-birthday">🎂 ${month}월 ${day}일${lunarLabel ? ` <small>(${lunarLabel})</small>` : ""}</span>
        </div>`).join("")}
    </div>
    ${teachers.some(x => x.lunarLabel) ? `<p class="dim-note" style="margin:8px 0 0;">음력 생일은 올해(${new Date().getFullYear()}년) 양력 날짜로 환산해서 표시합니다.</p>` : ""}`
    : `<p class="list empty">${month}월 생일인 교사가 없습니다.</p>`;

  wrap.innerHTML = `
    <div class="bd-section-head"><h3>🎓 학생 생일자</h3><span class="dim-note">${sorted.length}명</span></div>
    ${studentHtml}
    <div class="bd-section-head bd-section-gap"><h3>🧑‍🏫 교사 생일자</h3><span class="dim-note">${teachers.length}명</span></div>
    ${teacherHtml}
  `;

  // 이름을 누르면 재적부/교사현황과 동일한 프로필 팝업이 뜸
  wrap.querySelectorAll(".student-name-link:not(.teacher-link)").forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      const student = getStudentsCache().find(s => s.id === e.currentTarget.dataset.studentId);
      if (student) openStudentProfileModal(student);
    };
  });
  wrap.querySelectorAll(".teacher-link").forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      const teacher = getTeachersCache().find(t => t.id === e.currentTarget.dataset.teacherId);
      if (teacher) openTeacherProfileModal(teacher);
    };
  });
}
