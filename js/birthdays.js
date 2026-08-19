import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache, openStudentProfileModal } from "./students.js";
import { $, escapeHtml, sortByName } from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";

// "월별 생일자" 화면: 달을 고르면 그 달에 생일인 학생을 학년순(반 순서) -> 가나다순으로 보여준다.
// 생일은 students.js의 학생 추가/수정 폼에서 <input type="date">로 입력된 "YYYY-MM-DD" 형식만 저장되므로
// (2026-08-17부터), 문자열에서 바로 월/일을 뽑아 쓴다.

export async function initBirthdaysView() {
  await loadClasses();
  await loadStudents();

  const monthSelect = $("#birthdayMonthSelect");
  const thisMonth = new Date().getMonth() + 1;
  monthSelect.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1)
    .map(m => `<option value="${m}" ${m === thisMonth ? "selected" : ""}>${m}월</option>`).join("");

  monthSelect.onchange = renderBirthdayList;
  renderBirthdayList();
}

function renderBirthdayList() {
  const month = Number($("#birthdayMonthSelect").value);
  const wrap = $("#birthdayListWrap");
  if (!month) { wrap.innerHTML = ""; return; }

  const classes = getClassesCache();
  const visible = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));
  const visibleIds = visible.map(c => c.id);
  // classes는 이미 Firestore에서 order 필드 기준으로 정렬되어 오므로(js/classes.js loadClasses),
  // 배열 안 위치를 그대로 "학년순" 정렬 기준으로 사용한다(재적부 등 다른 화면과 동일한 방식).
  const classOrder = Object.fromEntries(classes.map((c, idx) => [c.id, idx]));
  const classMap = Object.fromEntries(classes.map(c => [c.id, c.name]));

  const students = getStudentsCache().filter(s => {
    if (!visibleIds.includes(s.classId)) return false;
    if (s.status === "removed") return false;
    if (!s.birthday || !/^\d{4}-\d{2}-\d{2}$/.test(s.birthday)) return false;
    return Number(s.birthday.split("-")[1]) === month;
  });

  const sorted = sortByName(students)
    .sort((a, b) => (classOrder[a.classId] ?? 999) - (classOrder[b.classId] ?? 999));

  if (!sorted.length) {
    wrap.innerHTML = `<p class="list empty">${month}월 생일인 학생이 없습니다.</p>`;
    return;
  }

  wrap.innerHTML = `
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
        </div>
      `;
      }).join("")}
    </div>
  `;

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
