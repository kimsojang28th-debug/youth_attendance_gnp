import {
  db, collection, getDocs, addDoc, updateDoc, deleteDoc, query, orderBy, doc, serverTimestamp
} from "./firebase-init.js";
import { $, escapeHtml, openModal, closeModal, parseDelimitedLine, formatPhone, phoneDigits, confirmTypeName } from "./utils.js";
import { isAdmin, isSystemAdmin, currentUser } from "./auth.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { callFn } from "./functions-client.js";
import { rosterForYear, getLiveYear, listArchivedYears } from "./terms.js";

// "교사현황" 화면: 청소년부 교사(부장/총무/회계/서기/각 반 담당 교사 등) 연락처 명단.
// 재적부(students.js)와 비슷한 구조지만 반 소속이 필수가 아니고(직분/담당은 자유 텍스트인 "비고"에 적음),
// 사진도 없는 더 단순한 CRUD 화면. 목록은 별도 컬렉션(teachers)에 저장.

let _teachersCache = [];
let _viewYear = null;      // null = 현재, 숫자 = 보관된 지난 학년도(읽기 전용)
let _showRetired = false;  // 퇴임 교사 표시 여부
let _archivedYears = [];
let _liveYear = null;

export async function loadTeachers(force = false) {
  if (_teachersCache.length && !force) return _teachersCache;
  const q = query(collection(db, "teachers"), orderBy("order"));
  const snap = await getDocs(q);
  _teachersCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _teachersCache;
}

export function getTeachersCache() {
  return _teachersCache;
}

export async function initTeachersView() {
  _viewYear = null;
  _showRetired = false;
  await Promise.all([loadTeachers(true), loadClasses()]);
  _archivedYears = await listArchivedYears();
  _liveYear = await getLiveYear();
  await renderTeachersView();
}

// ----- 계정(로그인) 관련 표시/동작 -----
function classNamesOf(t) {
  const map = Object.fromEntries(getClassesCache().map(c => [c.id, c.name]));
  return (t.classIds || []).map(id => map[id]).filter(Boolean);
}

// 목록에서 바로 담당반을 체크하는 펼침 선택창 (체크하면 즉시 저장)
function inlineClassPicker(t) {
  const classes = getClassesCache();
  const label = classNamesOf(t).join(", ") || "선택 안 함";
  return `<details class="nw-dd inline-dd" data-id="${t.id}"><summary>${escapeHtml(label)}</summary><div class="nw-dd-list">` +
    classes.map(c => `<label class="class-check"><input type="checkbox" class="inlineClass" data-id="${t.id}" value="${c.id}" ${(t.classIds || []).includes(c.id) ? "checked" : ""}> ${escapeHtml(c.name)}</label>`).join("") +
    `</div></details>`;
}

function accountBadge(t) {
  const role = t.isAdmin ? ` <span class="badge badge-admin">관리자</span>` : "";
  if (t.retired) return `<span class="badge badge-removed">퇴임${t.retiredYear ? ` (${t.retiredYear})` : ""}</span>${role}`;
  if (t.loginEnabled === false) return `<span class="badge badge-removed">로그인 제한</span>${role}`;
  if (t.uid && t.resetRequested) return `<span class="badge badge-hold">재설정 요청</span>${role}`;
  if (t.uid) return `<span class="badge badge-active">가입</span>${role}`;
  return `<span class="badge badge-removed">미가입</span>${role}`;
}

async function resetPasswordOf(t) {
  if (!confirm(`"${t.name}" 교사의 비밀번호를 초기화할까요?\n\n초기화하면 기존 비밀번호는 쓸 수 없게 되고, 교사가 로그인 화면에서 새 비밀번호를 두 번 입력해 다시 설정하게 됩니다.`)) return false;
  try {
    await callFn("adminResetPassword", { teacherId: t.id });
  } catch (err) {
    alert(`초기화하지 못했습니다: ${err.message || err}`);
    return false;
  }
  await loadTeachers(true);
  alert(`"${t.name}" 교사의 비밀번호를 초기화했습니다.\n교사에게 로그인 화면에서 새 비밀번호를 만들도록 안내해주세요.`);
  return true;
}

async function renderTeachersView() {
  const past = !!_viewYear;
  // 지난 학년도: 그해 보관 명부(읽기 전용). 현재: 퇴임하지 않은 교사 (옵션으로 퇴임 교사도 표시)
  const admin = isAdmin() && !past;
  let teachers;
  if (past) {
    const roster = await rosterForYear(_viewYear);
    const names = Object.fromEntries(roster.classes.map(c => [c.id, c.name]));
    teachers = roster.teachers.map(t => ({ ...t, _classNames: (t.classIds || []).map(id => names[id]).filter(Boolean) }));
  } else {
    teachers = getTeachersCache().filter(t => _showRetired || !t.retired);
  }
  const wrap = $("#view-teachers");

  wrap.innerHTML = `
    <h2>교사현황</h2>
    <div class="toolbar" style="margin-bottom:10px;">
      ${_archivedYears.length ? `<select id="teachersYearSelect" title="학년도">
        <option value="">현재 (${_liveYear}학년도)</option>
        ${_archivedYears.map(y => `<option value="${y}" ${y === _viewYear ? "selected" : ""}>${y}학년도 (보관)</option>`).join("")}
      </select>` : ""}
      ${past ? `<span class="dim-note">${_viewYear}학년도에 활동한 교사 명단입니다. (읽기 전용)</span>`
        : `<label class="class-check"><input type="checkbox" id="showRetiredChk" ${_showRetired ? "checked" : ""} /> 퇴임 교사도 보기</label>`}
    </div>
    ${admin
      ? `<div class="toolbar">
          <button id="addTeacherBtn" class="btn btn-primary">+ 교사 추가</button>
          <button id="bulkImportTeacherBtn" class="btn">일괄등록</button>
        </div>`
      : `<p class="dim-note" style="margin-bottom:12px;">교사 정보 추가/수정/삭제는 관리자만 할 수 있습니다.</p>`}
    <div class="table-scroll">
    <table class="students-table teachers-table">
      <thead><tr><th class="st-name-col">이름</th><th>전화번호</th><th>담당반</th>${admin ? `<th>계정</th>` : ""}<th>비고</th></tr></thead>
      <tbody>
        ${teachers.length ? teachers.map(t => `
          <tr data-id="${t.id}">
            <td class="st-name-col">
              <span class="st-nm">
                <a href="#" class="student-name-link teacher-name-link" data-teacher-id="${t.id}">${escapeHtml(t.name)}</a>
                <span class="st-gender ${t.gender === "F" ? "st-gender-f" : "st-gender-m"}">${t.gender === "F" ? "여" : "남"}</span>
              </span>
            </td>
            <td>${t.phone ? escapeHtml(t.phone) : (admin ? `<span class="dim-note">연락처 없음(로그인 불가)</span>` : "-")}</td>
            <td>${admin && !past && !t.retired ? inlineClassPicker(t) : ((t._classNames || classNamesOf(t)).map(escapeHtml).join(", ") || "-")}</td>
            ${admin ? `<td class="acct-cell">${accountBadge(t)}${t.uid ? ` <button class="btn btn-sm resetPwBtn" data-id="${t.id}">초기화</button>` : ""}${!past && !t.retired ? `<label class="login-sw"><input type="checkbox" class="loginSwitch" data-id="${t.id}" ${t.loginEnabled === false ? "" : "checked"}> 로그인 허용</label>` : ""}</td>` : ""}
            <td>${escapeHtml(t.note || "-")}</td>
          </tr>
        `).join("") : `<tr><td colspan="${admin ? 5 : 4}"><p class="list empty">등록된 교사가 없습니다.</p></td></tr>`}
      </tbody>
    </table>
    </div>
  `;

  const ysel = $("#teachersYearSelect");
  if (ysel) ysel.onchange = async () => { _viewYear = ysel.value ? Number(ysel.value) : null; await renderTeachersView(); };
  const retChk = $("#showRetiredChk");
  if (retChk) retChk.onchange = async () => { _showRetired = retChk.checked; await renderTeachersView(); };

  // 이름을 누르면 생일/전화번호/주소/이메일까지 보이는 프로필 팝업이 뜸(재적부와 동일한 패턴)
  wrap.querySelectorAll(".teacher-name-link").forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      const id = e.currentTarget.dataset.teacherId;
      const teacher = getTeachersCache().find(t => t.id === id);
      if (teacher) openTeacherProfileModal(teacher);
    };
  });

  if (!admin) return;
  wrap.querySelectorAll(".resetPwBtn").forEach(btn => {
    btn.onclick = async () => {
      const t = getTeachersCache().find(x => x.id === btn.dataset.id);
      if (t && await resetPasswordOf(t)) renderTeachersView();
    };
  });
  // 담당반 체크: 바뀔 때마다 즉시 저장
  wrap.querySelectorAll(".inlineClass").forEach(cb => {
    cb.onchange = async () => {
      const id = cb.dataset.id;
      const t = getTeachersCache().find(x => x.id === id);
      const box = cb.closest("details");
      const ids = [...box.querySelectorAll(".inlineClass:checked")].map(el => el.value);
      try {
        await updateDoc(doc(db, "teachers", id), { classIds: ids });
        if (t) t.classIds = ids;
        box.querySelector("summary").textContent = classNamesOf({ classIds: ids }).join(", ") || "선택 안 함";
        box.classList.add("saved-flash");
        setTimeout(() => box.classList.remove("saved-flash"), 900);
      } catch (err) {
        alert(`담당반을 저장하지 못했습니다: ${err.message || err}`);
        await loadTeachers(true);
        renderTeachersView();
      }
    };
  });
  // 로그인 허용 스위치 (끌 때는 확인창)
  wrap.querySelectorAll(".loginSwitch").forEach(sw => {
    sw.onchange = async () => {
      const t = getTeachersCache().find(x => x.id === sw.dataset.id);
      if (!t) return;
      const revert = () => { sw.checked = !sw.checked; };
      const enable = sw.checked;
      if (!enable) {
        if (currentUser && currentUser.teacherId === t.id) { alert("본인 계정의 로그인은 끌 수 없습니다."); revert(); return; }
        if (t.isAdmin && !isSystemAdmin()) { alert("관리자 계정은 시스템 관리자만 바꿀 수 있습니다."); revert(); return; }
        if (!confirm(`"${t.name}" 교사의 로그인을 막을까요?\n막으면 이 교사는 앱에 접속할 수 없습니다. (언제든 다시 허용할 수 있습니다)`)) { revert(); return; }
      }
      try {
        await updateDoc(doc(db, "teachers", t.id), { loginEnabled: enable });
        t.loginEnabled = enable;
        renderTeachersView();
      } catch (err) {
        alert(`저장하지 못했습니다: ${err.message || err}`);
        revert();
      }
    };
  });
  $("#addTeacherBtn").onclick = () => openTeacherModal();
  $("#bulkImportTeacherBtn").onclick = () => openBulkImportModal();
}

export function openTeacherProfileModal(teacher) {
  openModal(`
    <div class="profile-header">
      <div>
        <h3 style="margin:0 0 4px;">${escapeHtml(teacher.name)}</h3>
        <p style="margin:0;color:#6b7280;font-size:13.5px;">${teacher.gender === "F" ? "여" : "남"}${teacher.note ? ` · ${escapeHtml(teacher.note)}` : ""}</p>
      </div>
    </div>
    <div class="profile-section">
      <div class="profile-field-row"><span class="profile-field-label">생일</span><span class="profile-field-value">${teacher.birthday ? `${escapeHtml(teacher.birthday)} (${teacher.lunar ? "음력" : "양력"})` : "-"}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">전화번호</span><span class="profile-field-value">${escapeHtml(teacher.phone || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">담당반</span><span class="profile-field-value">${classNamesOf(teacher).map(escapeHtml).join(", ") || "-"}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">주소</span><span class="profile-field-value">${escapeHtml(teacher.address || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">이메일</span><span class="profile-field-value">${escapeHtml(teacher.email || "-")}</span></div>
    </div>
    <div class="modal-actions">
      ${isAdmin() ? `<button id="editFromProfileBtn" class="btn">정보 수정</button>` : ""}
      <button id="cancelBtn" class="btn">닫기</button>
    </div>
  `, { wide: true });

  $("#cancelBtn").onclick = closeModal;
  if (isAdmin()) {
    $("#editFromProfileBtn").onclick = () => openTeacherModal(teacher);
  }
}

function openTeacherModal(teacher = null) {
  const isEdit = !!teacher;

  openModal(`
    <h3>${isEdit ? "교사 정보 수정" : "교사 추가"}</h3>
    <label>이름</label>
    <input id="f_name" value="${escapeHtml(teacher?.name || "")}" />
    <label>성별</label>
    <select id="f_gender">
      <option value="M" ${teacher?.gender !== "F" ? "selected" : ""}>남</option>
      <option value="F" ${teacher?.gender === "F" ? "selected" : ""}>여</option>
    </select>
    <label>생일</label>
    <div style="display:flex;gap:8px;">
      <input type="date" id="f_birthday" value="${escapeHtml(teacher?.birthday || "")}" style="flex:1;" />
      <select id="f_lunar" style="flex:0 0 96px;">
        <option value="false" ${!teacher?.lunar ? "selected" : ""}>양력</option>
        <option value="true" ${teacher?.lunar ? "selected" : ""}>음력</option>
      </select>
    </div>
    <label>전화번호 <span class="dim-note">(로그인 시 이름과 함께 사용됩니다)</span></label>
    <input id="f_phone" data-phone inputmode="tel" value="${escapeHtml(teacher?.phone || "")}" placeholder="010-0000-0000 (숫자만 입력)" />
    <label>주소</label>
    <input id="f_address" value="${escapeHtml(teacher?.address || "")}" />
    <label>이메일</label>
    <input id="f_email" value="${escapeHtml(teacher?.email || "")}" />
    <label>비고 (직분 등)</label>
    <input id="f_note" value="${escapeHtml(teacher?.note || "")}" placeholder="예: 부장, 회계, 총무" />
    <label>담당반 <span class="dim-note">(재적부에서 이 반 학생을 수정할 수 있고, 출석 화면의 기본 반이 됩니다. 출석 입력은 모든 반에서 가능)</span></label>
    <div class="class-check-list">
      ${getClassesCache().map(c => `<label class="class-check"><input type="checkbox" class="f_class" value="${c.id}" ${(teacher?.classIds || []).includes(c.id) ? "checked" : ""} /> ${escapeHtml(c.name)}</label>`).join("") || `<span class="dim-note">등록된 반이 없습니다.</span>`}
    </div>
    <label class="class-check" style="margin-top:12px;"><input type="checkbox" id="f_loginEnabled" ${teacher?.loginEnabled === false ? "" : "checked"} /> 로그인 허용 <span class="dim-note">(해제하면 이 교사는 접속할 수 없습니다)</span></label>
    ${isEdit ? `
    <div class="acct-box">
      <div><b>계정 상태</b> ${accountBadge(teacher)}</div>
      <div class="acct-actions">
        ${teacher.uid ? `<button id="resetPwInModal" class="btn btn-sm">비밀번호 초기화</button>` : `<span class="dim-note">아직 가입 전입니다. 교사가 로그인 화면에서 직접 가입합니다.</span>`}
        ${isSystemAdmin() ? `<button id="toggleAdminBtn" class="btn btn-sm">${teacher.isAdmin ? "일반관리자 해제" : "일반관리자로 지정"}</button>` : ""}
      </div>
    </div>` : ""}
    <div class="modal-actions">
      ${isEdit ? `<button id="deleteTeacherBtn" class="btn btn-danger">삭제</button>` : ""}
      <button id="cancelBtn" class="btn">취소</button>
      <button id="saveTeacherBtn" class="btn btn-primary">저장</button>
    </div>
    <p id="teacherModalMsg" style="font-size:12.5px;color:#e03131;margin-top:8px;"></p>
  `, { wide: true });

  $("#cancelBtn").onclick = closeModal;

  if (isEdit) {
    $("#deleteTeacherBtn").onclick = async () => {
      if (!(await confirmTypeName({
        title: "교사 삭제",
        name: teacher.name,
        bodyHtml: `<p>교사 정보${teacher.uid ? "와 <b>로그인 계정</b>" : ""}이 삭제되며 되돌릴 수 없습니다.</p><p class="dim-note">퇴임이나 접속 제한이 목적이라면 삭제하지 말고 목록의 "로그인 허용"을 끄거나, 새 학년도 편성에서 퇴임 처리해 주세요. 지난 학년도 교사 기록이 남습니다.</p>`
      }))) return;
      try {
        if (teacher.uid) await callFn("adminDeleteAccount", { teacherId: teacher.id });
        await deleteDoc(doc(db, "teachers", teacher.id));
      } catch (err) {
        $("#teacherModalMsg").textContent = `삭제 중 오류가 발생했습니다: ${err.message || err}`;
        return;
      }
      await loadTeachers(true);
      closeModal();
      renderTeachersView();
    };
  }

  if (isEdit) {
    const resetBtn = $("#resetPwInModal");
    if (resetBtn) resetBtn.onclick = async () => {
      if (await resetPasswordOf(teacher)) { closeModal(); renderTeachersView(); }
    };
    const roleBtn = $("#toggleAdminBtn");
    if (roleBtn) roleBtn.onclick = async () => {
      const make = !teacher.isAdmin;
      if (!confirm(make
        ? `"${teacher.name}" 교사를 일반관리자로 지정할까요?\n(교사·반·재적 관리와 다른 교사의 비밀번호 초기화를 할 수 있게 됩니다.)`
        : `"${teacher.name}" 교사의 일반관리자 권한을 해제할까요?`)) return;
      try {
        await callFn("adminSetRole", { teacherId: teacher.id, admin: make });
      } catch (err) {
        $("#teacherModalMsg").textContent = `변경하지 못했습니다: ${err.message || err}`;
        return;
      }
      await loadTeachers(true);
      closeModal();
      renderTeachersView();
    };
  }

  $("#saveTeacherBtn").onclick = async () => {
    const name = $("#f_name").value.trim();
    if (!name) { $("#teacherModalMsg").textContent = "이름을 입력해주세요."; return; }
    const phoneVal = $("#f_phone").value.trim();
    const digits = (v) => String(v || "").replace(/\D/g, "");
    const norm = (v) => String(v || "").replace(/\s+/g, "");
    if (digits(phoneVal) && getTeachersCache().some(o => o.id !== teacher?.id && norm(o.name) === norm(name) && digits(o.phone) === digits(phoneVal))) {
      $("#teacherModalMsg").textContent = "같은 이름과 연락처의 교사가 이미 등록되어 있습니다.";
      return;
    }
    const data = {
      classIds: [...document.querySelectorAll(".f_class:checked")].map(el => el.value),
      loginEnabled: $("#f_loginEnabled").checked,
      name,
      gender: $("#f_gender").value,
      birthday: $("#f_birthday").value || "",
      lunar: $("#f_lunar").value === "true",
      phone: formatPhone($("#f_phone").value),
      address: $("#f_address").value.trim(),
      email: $("#f_email").value.trim(),
      note: $("#f_note").value.trim()
    };
    try {
      if (isEdit) {
        await updateDoc(doc(db, "teachers", teacher.id), data);
      } else {
        const maxOrder = getTeachersCache().reduce((m, t) => Math.max(m, t.order || 0), 0);
        await addDoc(collection(db, "teachers"), { ...data, order: maxOrder + 1, createdAt: serverTimestamp() });
      }
    } catch (err) {
      $("#teacherModalMsg").textContent = `저장 중 오류가 발생했습니다: ${err.message || err}`;
      return;
    }
    await loadTeachers(true);
    closeModal();
    renderTeachersView();
  };
}

// ===== 일괄등록 =====
const BULK_IMPORT_COLUMNS = ["이름", "성별", "생일", "양력/음력", "전화번호", "주소", "이메일", "비고"];

function openBulkImportModal() {
  openModal(`
    <h3>교사 일괄 등록</h3>
    <p style="font-size:13px;color:#6b7280;">
      한 줄에 교사 한 명씩, 아래 순서로 붙여넣어주세요. 이름만 필수이고 나머지는 비워둬도 됩니다.<br/>
      구글시트/엑셀에서 여러 열을 그대로 복사해서 붙여넣어도 됩니다. (쉼표 또는 탭 구분 모두 지원, 주소 등에 쉼표가 들어있으면 탭 구분으로 붙여넣어주세요)<br/>
      <code>${BULK_IMPORT_COLUMNS.join(", ")}</code><br/>
      성별은 "남"/"여"로 적어주세요(비워두면 "남"으로 등록됩니다). 양력/음력 칸에는 "음력"이라고 적은 경우만 음력으로 등록되고, 나머지는 전부 양력으로 등록됩니다.<br/>
      생일은 <code>YYYY-MM-DD</code> 형식으로 넣어주세요(예: 1989-02-05). 형식이 안 맞으면 빈 값으로 등록됩니다.
    </p>
    <textarea id="teacherCsvInput" rows="10" placeholder="이상호,남,1989-02-05,양력,010-4312-4773,파주시 와석순환로 307 1110동 1602호,issace@naver.com,전도사"></textarea>
    <div class="modal-actions">
      <button id="cancelBtn" class="btn">취소</button>
      <button id="teacherImportBtn" class="btn btn-primary">등록</button>
    </div>
    <p id="teacherImportMsg" style="font-size:13px;margin-top:8px;"></p>
  `);

  $("#cancelBtn").onclick = closeModal;
  $("#teacherImportBtn").onclick = async () => {
    const text = $("#teacherCsvInput").value.trim();
    if (!text) return;
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    let success = 0, fail = 0;
    const failedLines = [];
    const maxOrder = getTeachersCache().reduce((m, t) => Math.max(m, t.order || 0), 0);

    for (const line of lines) {
      const parts = parseDelimitedLine(line).map(p => p.trim());
      const [name, genderRaw, birthdayRaw, lunarRaw, phone, address, email, note] = parts;
      if (!name) { fail++; failedLines.push(line); continue; }
      if (phoneDigits(phone).length >= 9 && getTeachersCache().some(o => String(o.name || "").replace(/\s+/g, "") === name.replace(/\s+/g, "") && phoneDigits(o.phone) === phoneDigits(phone))) {
        fail++; failedLines.push(line + " (이미 등록된 교사)"); continue;
      }
      const gender = (genderRaw === "여" || genderRaw === "F") ? "F" : "M";
      const birthday = /^\d{4}-\d{2}-\d{2}$/.test(birthdayRaw || "") ? birthdayRaw : "";
      const lunar = lunarRaw === "음력";
      try {
        await addDoc(collection(db, "teachers"), {
          name, gender, birthday, lunar,
          phone: formatPhone(phone), address: address || "", email: email || "", note: note || "",
          order: maxOrder + success + 1, createdAt: serverTimestamp()
        });
        _teachersCache.push({ id: "tmp" + success, name, phone: formatPhone(phone) }); // 같은 파일 안의 중복 방지용(저장 후 다시 불러옴)
        success++;
      } catch (err) {
        fail++;
        failedLines.push(`${line} (오류: ${err.message || err})`);
      }
    }
    $("#teacherImportMsg").innerHTML = `${success}명 등록 완료${fail ? `, ${fail}건 실패` : ""}` +
      (failedLines.length ? `<br/><span style="color:#e03131;">실패 항목: ${failedLines.map(escapeHtml).join(" / ")}</span>` : "");
    await loadTeachers(true);
    renderTeachersView();
  };
}
