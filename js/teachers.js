import {
  db, collection, getDocs, addDoc, updateDoc, deleteDoc, query, orderBy, doc, serverTimestamp
} from "./firebase-init.js";
import { $, escapeHtml, openModal, closeModal, parseDelimitedLine } from "./utils.js";
import { isAdmin } from "./auth.js";

// "교사현황" 화면: 청소년부 교사(부장/총무/회계/서기/각 반 담당 교사 등) 연락처 명단.
// 재적부(students.js)와 비슷한 구조지만 반 소속이 필수가 아니고(직분/담당은 자유 텍스트인 "비고"에 적음),
// 사진도 없는 더 단순한 CRUD 화면. 목록은 별도 컬렉션(teachers)에 저장.

let _teachersCache = [];

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
  await loadTeachers(true);
  renderTeachersView();
}

function renderTeachersView() {
  const admin = isAdmin();
  const teachers = getTeachersCache();
  const wrap = $("#view-teachers");

  wrap.innerHTML = `
    <h2>교사현황</h2>
    ${admin
      ? `<div class="toolbar">
          <button id="addTeacherBtn" class="btn btn-primary">+ 교사 추가</button>
          <button id="bulkImportTeacherBtn" class="btn">일괄등록</button>
        </div>`
      : `<p class="dim-note" style="margin-bottom:12px;">교사 정보 추가/수정/삭제는 관리자(부장)만 할 수 있습니다.</p>`}
    <div class="table-scroll">
    <table>
      <thead><tr><th>이름</th><th>성별</th><th>전화번호</th><th>비고</th></tr></thead>
      <tbody>
        ${teachers.length ? teachers.map(t => `
          <tr data-id="${t.id}">
            <td><a href="#" class="student-name-link teacher-name-link" data-teacher-id="${t.id}">${escapeHtml(t.name)}</a></td>
            <td>${t.gender === "F" ? "여" : "남"}</td>
            <td>${escapeHtml(t.phone || "-")}</td>
            <td>${escapeHtml(t.note || "-")}</td>
          </tr>
        `).join("") : `<tr><td colspan="4"><p class="list empty">등록된 교사가 없습니다.</p></td></tr>`}
      </tbody>
    </table>
    </div>
  `;

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
  $("#addTeacherBtn").onclick = () => openTeacherModal();
  $("#bulkImportTeacherBtn").onclick = () => openBulkImportModal();
}

function openTeacherProfileModal(teacher) {
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
    <label>전화번호</label>
    <input id="f_phone" value="${escapeHtml(teacher?.phone || "")}" />
    <label>주소</label>
    <input id="f_address" value="${escapeHtml(teacher?.address || "")}" />
    <label>이메일</label>
    <input id="f_email" value="${escapeHtml(teacher?.email || "")}" />
    <label>비고 (직분/담당 반 등)</label>
    <input id="f_note" value="${escapeHtml(teacher?.note || "")}" placeholder="예: 부장, 회계, 고2남 담당" />
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
      if (!confirm(`"${teacher.name}" 교사 정보를 삭제할까요?`)) return;
      try {
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

  $("#saveTeacherBtn").onclick = async () => {
    const name = $("#f_name").value.trim();
    if (!name) { $("#teacherModalMsg").textContent = "이름을 입력해주세요."; return; }
    const data = {
      name,
      gender: $("#f_gender").value,
      birthday: $("#f_birthday").value || "",
      lunar: $("#f_lunar").value === "true",
      phone: $("#f_phone").value.trim(),
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
      const gender = (genderRaw === "여" || genderRaw === "F") ? "F" : "M";
      const birthday = /^\d{4}-\d{2}-\d{2}$/.test(birthdayRaw || "") ? birthdayRaw : "";
      const lunar = lunarRaw === "음력";
      try {
        await addDoc(collection(db, "teachers"), {
          name, gender, birthday, lunar,
          phone: phone || "", address: address || "", email: email || "", note: note || "",
          order: maxOrder + success + 1, createdAt: serverTimestamp()
        });
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
