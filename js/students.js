import {
  db, collection, getDocs, addDoc, updateDoc, deleteDoc, doc, query, orderBy, serverTimestamp
} from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import {
  $, $all, escapeHtml, STUDENT_STATUS_LABEL, openModal, closeModal, todayISO, parseDelimitedLine, sortByName
} from "./utils.js";
import { isAdmin, canEditClass } from "./auth.js";
import { addHistoryRecord, deleteHistoryForStudent } from "./history.js";
import { requestAnnualClass } from "./annual.js";

let _studentsCache = [];

export async function loadStudents(force = false) {
  if (_studentsCache.length && !force) return _studentsCache;
  const q = query(collection(db, "students"), orderBy("order"));
  const snap = await getDocs(q);
  _studentsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _studentsCache;
}

export function getStudentsCache() {
  return _studentsCache;
}

// 이름 앞에 붙는 작은 원형 프로필 사진(있으면 사진, 없으면 👤 아이콘). 재적부 테이블에서 쓰던 마크업을
// 대시보드(장기결석 명단)/주간보고서/연간출석부/출석체크 등 다른 화면에서도 그대로 재사용하기 위해
// 공용 함수로 분리함(2026-08-20). student가 없거나 photoDataUrl이 없으면 자동으로 placeholder를 보여줌.
export function studentThumbHtml(student) {
  return student?.photoDataUrl
    ? `<img class="student-thumb" src="${student.photoDataUrl}" alt="" />`
    : `<span class="student-thumb student-thumb-placeholder">👤</span>`;
}

export async function initStudentsView() {
  const classes = await loadClasses();
  // 재적부 조회는 모든 교사가 전체 반을 볼 수 있고, 학생 추가/수정/삭제는 관리자 또는 해당 반 담당교사만 가능
  const visibleClasses = classes;
  const editableClasses = classes.filter(c => canEditClass(c.id));

  const classFilter = $("#studentsClassFilter");
  classFilter.innerHTML = `<option value="all">전체 반</option>` +
    visibleClasses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  $("#studentsClassFilter").onchange = renderStudentsTable;
  $("#studentsStatusFilter").onchange = renderStudentsTable;
  $("#addStudentBtn").onclick = () => openStudentModal();
  $("#bulkImportBtn").onclick = () => openBulkImportModal(editableClasses);
  // 담당반이 없는 교사는 학생을 추가/일괄등록/졸업처리 할 수 없으므로 버튼을 숨김
  ["addStudentBtn", "bulkImportBtn", "studentsBulkGraduateBtn"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", editableClasses.length === 0);
  });
  $("#studentsBulkGraduateBtn").onclick = handleBulkGraduate;

  await loadStudents(true);
  renderStudentsTable();
}

// 2026-08-23(5차): 연말에 고3 학생들을 한 번에 "졸업" 상태로 바꾸는 일괄 처리 기능.
// 개별 학생 수정 화면에서 하나씩 상태를 바꾸는 것과 결과는 같지만(상태 변경 + 재적변동이력 기록),
// 여러 명을 한 번에 처리할 수 있게 해줌.
async function handleBulkGraduate() {
  const wrap = $("#studentsTableWrap");
  const checkedIds = $all(".studentRowCheck:checked", wrap).map(cb => cb.closest("tr").dataset.id);
  if (!checkedIds.length) return;
  const targets = _studentsCache.filter(s => checkedIds.includes(s.id) && s.status !== "graduated" && canEditClass(s.classId));
  if (!targets.length) {
    alert("선택한 학생은 이미 모두 졸업 처리되어 있습니다.");
    return;
  }
  if (!confirm(
    `선택한 ${targets.length}명을 "졸업" 상태로 일괄 변경할까요?\n` +
    `(졸업 처리되면 출석체크·주간보고서·연간출석부·생일자·통계 등 청소년부 현재 활동 화면에서는 ` +
    `자동으로 빠지고, 재적부 목록에서는 "졸업" 상태로 계속 조회할 수 있습니다.)`
  )) return;

  const today = todayISO();
  let success = 0, fail = 0;
  for (const s of targets) {
    try {
      await updateDoc(doc(db, "students", s.id), { status: "graduated" });
      await addHistoryRecord({
        studentId: s.id, studentName: s.name, classId: s.classId,
        type: "graduated", date: today, note: "일괄 졸업처리"
      });
      success++;
    } catch (err) {
      fail++;
    }
  }
  await loadStudents(true);
  renderStudentsTable();
  alert(`${success}명 졸업 처리 완료${fail ? `, ${fail}건 실패` : ""}`);
}


async function renderStudentsTable() {
  const classId = $("#studentsClassFilter").value;
  const status = $("#studentsStatusFilter").value;
  const classes = getClassesCache();
  const classMap = Object.fromEntries(classes.map(c => [c.id, c.name]));

  let list = _studentsCache.filter(s => {
    if (classId !== "all" && s.classId !== classId) return false;
    if (status !== "all" && s.status !== status) return false;
    return true;
  });

  // 반 순서(학년/반 정의 순서) -> 그 안에서는 이름 가나다순으로 정렬
  const classOrder = Object.fromEntries(classes.map((c, idx) => [c.id, idx]));
  list = sortByName(list).sort((a, b) => (classOrder[a.classId] ?? 999) - (classOrder[b.classId] ?? 999));

  const wrap = $("#studentsTableWrap");

  if (!list.length) {
    wrap.innerHTML = `<div class="panel"><p class="list empty">표시할 학생이 없습니다.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="table-scroll">
    <table>
      <thead><tr>
        <th><input type="checkbox" id="studentsSelectAll" /></th>
        <th>이름</th><th>반</th><th>성별</th><th>상태</th><th>연락처</th><th>학교</th><th></th>
      </tr></thead>
      <tbody>
        ${list.map(s => `
          <tr data-id="${s.id}">
            <td>${canEditClass(s.classId) ? `<input type="checkbox" class="studentRowCheck" />` : ""}</td>
            <td>
              <span class="student-name-cell">
                ${studentThumbHtml(s)}
                <a href="#" class="student-name-link">${escapeHtml(s.name)}</a>
              </span>
            </td>
            <td>${escapeHtml(classMap[s.classId] || s.classId)}${s.classId === "newcomer" && s.plannedClassId ? ` <span class="dim-note" style="font-size:11px;">(예정:${escapeHtml(classMap[s.plannedClassId] || "")})</span>` : ""}</td>
            <td>${s.gender === "F" ? "여" : "남"}</td>
            <td><span class="badge badge-${s.status}">${STUDENT_STATUS_LABEL[s.status] || s.status}</span></td>
            <td>${escapeHtml(s.phone || "")}</td>
            <td>${escapeHtml(s.school || "")}</td>
            <td>${canEditClass(s.classId) ? `<button class="btn btn-sm editStudentBtn">수정</button>` : ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;

  // 2026-08-23(5차): 연말에 고3 학생 여러 명을 한 번에 "졸업" 상태로 바꿀 수 있는 일괄 처리용
  // 체크박스. 재적변동이력의 "선택 삭제" 체크박스와 동일한 방식(전체선택 + 행별 체크 + 버튼 활성화).
  const bulkBtn = $("#studentsBulkGraduateBtn");
  const updateBulkBtnState = () => {
    if (bulkBtn) bulkBtn.disabled = !$all(".studentRowCheck").some(cb => cb.checked);
  };
  if (bulkBtn) bulkBtn.disabled = true;
  const selectAll = $("#studentsSelectAll");
  if (selectAll) {
    selectAll.onchange = (e) => {
      $all(".studentRowCheck").forEach(cb => { cb.checked = e.target.checked; });
      updateBulkBtnState();
    };
  }
  wrap.querySelectorAll(".studentRowCheck").forEach(cb => { cb.onchange = updateBulkBtnState; });

  // 이름을 누르면 사진/연락처/주소/보호자 정보 등을 한 번에 볼 수 있는 프로필 보기 모달이 뜸.
  // (기존 "수정" 버튼은 그대로 두고, 이름 클릭은 별도의 읽기 전용 프로필 화면으로 연결)
  wrap.querySelectorAll(".student-name-link").forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      const id = e.target.closest("tr").dataset.id;
      const student = _studentsCache.find(s => s.id === id);
      openStudentProfileModal(student);
    };
  });

  wrap.querySelectorAll(".editStudentBtn").forEach(btn => {
    btn.onclick = (e) => {
      const id = e.target.closest("tr").dataset.id;
      const student = _studentsCache.find(s => s.id === id);
      openStudentModal(student);
    };
  });
}

// 재적부에서 학생 이름을 클릭했을 때 뜨는 읽기 전용 프로필 화면.
// 사진 + 기본정보 + 주소 + 보호자 연락처 + 세례여부/장학금 + 비고를 한 번에 확인할 수 있음.
export function openStudentProfileModal(student) {
  const classes = getClassesCache();
  const className = classes.find(c => c.id === student.classId)?.name || student.classId;
  const guardians = student.guardians || [];

  openModal(`
    <div class="profile-header">
      ${student.photoDataUrl
        ? `<img class="profile-photo" src="${student.photoDataUrl}" />`
        : `<div class="profile-photo profile-photo-placeholder">👤</div>`}
      <div>
        <h3 style="margin:0 0 4px;">${escapeHtml(student.name)}</h3>
        <p style="margin:0;color:#6b7280;font-size:13.5px;">
          ${escapeHtml(className)} · ${student.gender === "F" ? "여" : "남"} ·
          <span class="badge badge-${student.status}">${STUDENT_STATUS_LABEL[student.status] || student.status}</span>
        </p>
      </div>
    </div>

    <div class="profile-section">
      <div class="profile-field-row"><span class="profile-field-label">전화번호</span><span class="profile-field-value">${escapeHtml(student.phone || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">학교</span><span class="profile-field-value">${escapeHtml(student.school || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">생일</span><span class="profile-field-value">${escapeHtml(student.birthday || "-")}</span></div>
      ${student.classId === "newcomer" ? `<div class="profile-field-row"><span class="profile-field-label">실제 학년(예정 반)</span><span class="profile-field-value">${escapeHtml(classes.find(c => c.id === student.plannedClassId)?.name || "미지정")}</span></div>` : ""}
      <div class="profile-field-row"><span class="profile-field-label">주소</span><span class="profile-field-value">${escapeHtml(student.address || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">등록일</span><span class="profile-field-value">${escapeHtml(student.joinDate || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">세례여부</span><span class="profile-field-value">${escapeHtml(student.baptismStatus || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">장학금</span><span class="profile-field-value">${(student.scholarships && student.scholarships.length) ? escapeHtml(student.scholarships.join(", ")) : "-"}</span></div>
    </div>

    <div class="profile-section">
      <h4>보호자 연락처</h4>
      ${guardians.length
        ? guardians.map(g => `
          <div class="profile-field-row">
            <span class="profile-field-label">${escapeHtml(g.relation || "보호자")}</span>
            <span class="profile-field-value">${escapeHtml(g.name || "-")}${g.phone ? ` · ${escapeHtml(g.phone)}` : ""}</span>
          </div>
        `).join("")
        : `<p class="list empty" style="padding:2px 0;">등록된 보호자 연락처가 없습니다.</p>`}
    </div>

    ${student.note ? `
      <div class="profile-section">
        <h4>비고</h4>
        <p style="white-space:pre-wrap;margin:0;font-size:13.5px;">${escapeHtml(student.note)}</p>
      </div>
    ` : ""}

    <div class="modal-actions">
      <button id="editFromProfileBtn" class="btn">정보 수정</button>
      <button id="cancelBtn" class="btn">닫기</button>
      <button id="viewAttendanceBtn" class="btn btn-primary">출석현황</button>
    </div>
  `, { wide: true });

  $("#cancelBtn").onclick = closeModal;
  $("#editFromProfileBtn").onclick = () => openStudentModal(student);
  // 이 학생이 속한 반의 연간출석부로 바로 이동. annual.js에 "다음에 열릴 때 이 반을 선택해달라"고
  // 미리 요청해두고(requestAnnualClass), 실제 화면 전환은 화면 주소(#annual)를 바꿔서 처리함
  // (app.js의 뷰 전환 로직을 그대로 재사용하기 위함 - 새로 만들지 않음).
  $("#viewAttendanceBtn").onclick = () => {
    requestAnnualClass(student.classId);
    closeModal();
    location.hash = "annual"; // app.js의 hashchange 처리가 연간출석부 화면으로 전환해줌
  };
}

// 보호자 연락처 한 줄(관계/이름/전화번호) 입력 폼 HTML
function guardianRowHtml(relation = "아버지", name = "", phone = "") {
  const options = ["아버지", "어머니", "할아버지", "할머니", "기타"];
  return `
    <div class="guardian-row">
      <select class="g_relation">
        ${options.map(o => `<option value="${o}" ${o === relation ? "selected" : ""}>${o}</option>`).join("")}
      </select>
      <input class="g_name" placeholder="이름" value="${escapeHtml(name)}" />
      <input class="g_phone" placeholder="전화번호" value="${escapeHtml(phone)}" />
      <button type="button" class="btn btn-sm btn-danger g_remove">삭제</button>
    </div>
  `;
}

// 장학금은 1년에 상반기/하반기 두 번 수여되고 여러 번 받을 수 있으므로, 단순 체크(수여 여부)가 아니라
// "언제 받았는지" 시기별로 다중 선택할 수 있게 함. 2023년부터 올해까지 자동으로 목록을 만들어서
// 해가 바뀌어도 매번 코드를 손대지 않고 최신 연도까지 항목이 늘어나도록 함.
// 다만 매년 항목이 계속 늘어나면 화면이 한없이 길어지므로, 최근 2개년(올해+작년)만 기본으로 펼쳐 보여주고
// 그보다 이전 연도는 "이전 연도 보기"를 눌러야 펼쳐지는 접이식 영역에 넣어 화면 길이를 일정하게 유지한다.
function scholarshipYearGroups() {
  const startYear = 2023;
  const thisYear = new Date().getFullYear();
  const allYears = [];
  for (let y = startYear; y <= thisYear; y++) allYears.push(y);
  const recentYears = allYears.slice(-2);
  const olderYears = allYears.slice(0, -2);
  return { recentYears, olderYears };
}

function periodsForYears(years) {
  const periods = [];
  years.forEach(y => periods.push(`${y}년상반기`, `${y}년하반기`));
  return periods;
}

function scholarshipCheckboxesHtml(periods, selected) {
  return periods.map(p => `
    <label class="scholarship-chip">
      <input type="checkbox" class="f_scholarship_period" value="${p}" ${selected.includes(p) ? "checked" : ""} /> ${p}
    </label>
  `).join("");
}

// 사진 파일을 최대 320px, JPEG 압축(quality 0.75)으로 축소해서 data URL 문자열로 변환.
// Firestore 문서 1개당 용량 제한(1MiB)에 안전하게 들어가도록 하기 위해 원본을 그대로 저장하지 않고
// 이렇게 축소함(보통 결과물이 수십 KB 수준). 별도의 Firebase Storage 설정 없이 학생 문서 안에 바로 저장됨.
function resizeImageToDataUrl(file, maxSize = 320, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("이미지를 불러올 수 없습니다. 지원되지 않는 이미지 형식일 수 있습니다(예: HEIC). JPG/PNG로 다시 시도해주세요."));
      img.onload = () => {
        // 브라우저가 이미지를 실제로 디코딩하지 못했는데도 onload가 조용히 불리는 경우(가로/세로 0)가
        // 있어서, 이 경우엔 깨진 이미지가 그대로 저장되지 않도록 여기서 명확히 오류 처리함.
        if (!img.naturalWidth || !img.naturalHeight) {
          reject(new Error("이미지를 읽는 데 문제가 있습니다(가로/세로 크기를 확인할 수 없음). 다른 이미지로 다시 시도해주세요."));
          return;
        }
        let { width, height } = img;
        if (width >= height && width > maxSize) {
          height = Math.round(height * (maxSize / width));
          width = maxSize;
        } else if (height > maxSize) {
          width = Math.round(width * (maxSize / height));
          height = maxSize;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        // toDataURL이 실패하면 "data:," 같은 빈 값을 조용히 돌려줄 수 있어서, 유효한 이미지
        // data URL 형식인지 한 번 더 확인한 뒤에만 성공으로 처리함(깨진 값이 그대로 저장되는 것 방지).
        if (!dataUrl || !dataUrl.startsWith("data:image/") || dataUrl.length < 50) {
          reject(new Error("이미지 변환에 실패했습니다. 다른 이미지로 다시 시도해주세요."));
          return;
        }
        resolve(dataUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function openStudentModal(student = null) {
  const classes = getClassesCache();
  const classMap = Object.fromEntries(classes.map(c => [c.id, c.name]));
  const visible = classes.filter(c => canEditClass(c.id)); // 수정/추가 가능한 반(관리자는 전체)
  const isEdit = !!student;

  let pendingPhotoDataUrl = null; // 사용자가 이번에 새로 고른 사진(아직 저장 전)
  let photoRemoved = false; // "사진 제거"를 눌렀는지

  const selectedScholarships = student?.scholarships || [];
  const { recentYears, olderYears } = scholarshipYearGroups();
  const olderPeriods = periodsForYears(olderYears);
  const hasOlderChecked = olderPeriods.some(p => selectedScholarships.includes(p));

  openModal(`
    <h3>${isEdit ? "학생 정보 수정" : "학생 추가"}</h3>

    <label>프로필 사진</label>
    <div class="photo-upload-row">
      <div id="photoDropZone" class="photo-drop-zone" tabindex="0" title="클릭한 뒤 Ctrl+V를 누르면 복사한 이미지를 붙여넣을 수 있습니다">
        <img id="photoPreview" class="photo-preview ${student?.photoDataUrl ? "" : "hidden"}" src="${student?.photoDataUrl || ""}" />
        <div id="photoPreviewPlaceholder" class="photo-preview photo-preview-placeholder ${student?.photoDataUrl ? "hidden" : ""}">👤</div>
      </div>
      <div>
        <input type="file" id="f_photoFile" accept="image/*" />
        <div><button type="button" id="removePhotoBtn" class="btn btn-sm" style="margin-top:6px;">사진 제거</button></div>
      </div>
    </div>
    <p style="font-size:12px;color:#868e96;margin:-4px 0 12px;">👆 위 동그란 사진 영역을 클릭한 뒤 Ctrl+V를 누르면, 다른 곳에서 복사해둔 이미지를 바로 붙여넣을 수 있습니다.</p>

    <label>이름</label>
    <input id="f_name" value="${escapeHtml(student?.name || "")}" />
    <label>상태</label>
    <select id="f_status">
      <option value="active" ${student?.status === "active" ? "selected" : ""}>재적</option>
      <option value="new" ${student?.status === "new" ? "selected" : ""}>새친구</option>
      <option value="hold" ${student?.status === "hold" ? "selected" : ""}>보류</option>
      <option value="removed" ${student?.status === "removed" ? "selected" : ""}>제적</option>
      <option value="graduated" ${student?.status === "graduated" ? "selected" : ""}>졸업</option>
    </select>
    <label>반</label>
    <select id="f_classId"></select>
    <div id="plannedClassWrap" class="hidden">
      <label>실제 학년(예정 반) <span style="font-weight:400;color:#868e96;font-size:12px;">- 나중에 재적으로 전환하면 이 반으로 자동 이동됩니다</span></label>
      <select id="f_plannedClassId">
        <option value="">선택 안 함</option>
        ${classes.filter(c => c.id !== "newcomer").map(c => `<option value="${c.id}" ${student?.plannedClassId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
      </select>
    </div>
    <label>성별</label>
    <select id="f_gender">
      <option value="M" ${student?.gender === "M" ? "selected" : ""}>남</option>
      <option value="F" ${student?.gender === "F" ? "selected" : ""}>여</option>
    </select>
    <label>등록일</label>
    <input type="date" id="f_joinDate" value="${student?.joinDate || todayISO()}" />

    <label>전화번호(학생)</label>
    <input id="f_phone" value="${escapeHtml(student?.phone || "")}" placeholder="010-0000-0000" />
    <label>학교명</label>
    <input id="f_school" value="${escapeHtml(student?.school || "")}" placeholder="예: 지산중" />
    <label>생일</label>
    <input type="date" id="f_birthday" value="${student?.birthday || ""}" />
    <label>주소</label>
    <input id="f_address" value="${escapeHtml(student?.address || "")}" />

    <label>보호자 연락처</label>
    <div id="guardianRows">
      ${(student?.guardians?.length ? student.guardians : [{ relation: "아버지", name: "", phone: "" }])
        .map(g => guardianRowHtml(g.relation, g.name, g.phone)).join("")}
    </div>
    <button type="button" id="addGuardianBtn" class="btn btn-sm">+ 보호자 추가</button>

    <label>세례여부</label>
    <select id="f_baptism">
      <option value="" ${!student?.baptismStatus ? "selected" : ""}>선택 안 함</option>
      <option value="학습" ${student?.baptismStatus === "학습" ? "selected" : ""}>학습</option>
      <option value="유아세례" ${student?.baptismStatus === "유아세례" ? "selected" : ""}>유아세례</option>
      <option value="입교" ${student?.baptismStatus === "입교" ? "selected" : ""}>입교</option>
      <option value="세례" ${student?.baptismStatus === "세례" ? "selected" : ""}>세례</option>
    </select>

    <label style="margin-top:14px;">장학금 수여 시기 (받은 시기를 모두 체크)</label>
    <div id="scholarshipSection">
      <div class="scholarship-grid">
        ${scholarshipCheckboxesHtml(periodsForYears(recentYears), selectedScholarships)}
      </div>
      ${olderYears.length ? `
        <details class="scholarship-older" ${hasOlderChecked ? "open" : ""}>
          <summary>이전 연도 보기 (${olderYears[0]}년~${olderYears[olderYears.length - 1]}년)</summary>
          <div class="scholarship-grid scholarship-grid-older">
            ${scholarshipCheckboxesHtml(olderPeriods, selectedScholarships)}
          </div>
        </details>
      ` : ""}
    </div>

    <label>비고</label>
    <textarea id="f_note" rows="2">${escapeHtml(student?.note || "")}</textarea>
    <div class="modal-actions">
      ${isEdit ? `<button id="deleteBtn" class="btn btn-danger">삭제</button>` : ""}
      <button id="cancelBtn" class="btn">취소</button>
      <button id="saveBtn" class="btn btn-primary">저장</button>
    </div>
  `, { wide: true });

  $("#cancelBtn").onclick = closeModal;

  // 2026-08-23: "새친구"는 더 이상 학년반에 소속된 채 상태값으로만 구분하지 않고, 별도의
  // "새친구반"(classId: newcomer)에 소속시켜 전담 선생님이 따로 관리하도록 정책이 바뀜.
  // 그래서 상태가 "새친구"면 반은 항상 "새친구반"으로 고정하고(다른 반 선택 불가), 그 대신
  // "실제 학년(예정 반)"을 별도로 기록해서 나중에 재적 전환 시 어느 반으로 보내야 할지 알 수 있게 함.
  // 반대로 상태가 새친구가 아니면(재적/보류/제적) 새친구반은 애초에 선택지에서 빼서, 실수로
  // 재적 학생이 새친구반에 남는 일이 없도록 함.
  function syncClassIdByStatus(isInitial = false) {
    const classIdSelect = $("#f_classId");
    const plannedWrap = $("#plannedClassWrap");
    if (!classIdSelect || !plannedWrap) return;
    if ($("#f_status").value === "new") {
      classIdSelect.innerHTML = `<option value="newcomer">새친구</option>`;
      classIdSelect.disabled = true;
      plannedWrap.classList.remove("hidden");
    } else {
      const options = visible.filter(c => c.id !== "newcomer");
      // 최초로 모달을 여는 시점(isInitial)에는 반 <select>가 아직 비어있는 채로 새로 만들어진
      // 상태라 classIdSelect.value가 항상 빈 문자열이다. 이때 무조건 "실제 학년(예정 반)"
      // 값으로만 기본값을 정하면, 수정하려는 기존 학생의 원래 반(student.classId)이 무시되고
      // 옵션 목록의 첫 번째 반(중1)이 그냥 브라우저 기본 선택으로 남아버려서, 학생 정보를
      // 수정할 때마다 반이 항상 "중1"로 보이는 문제가 있었다. 그래서 최초 오픈 시에는 수정 중인
      // 학생의 현재 반(student.classId)을 최우선으로 사용하고, 그 외(상태를 새친구 -> 재적 등으로
      // 방금 바꾼 경우)에는 기존 로직대로 예정 반/현재 선택값을 사용한다.
      const preferId = isInitial
        ? (student && student.classId && student.classId !== "newcomer" ? student.classId : (student?.plannedClassId || ""))
        : (!classIdSelect.value || classIdSelect.value === "newcomer")
          ? ($("#f_plannedClassId")?.value || student?.plannedClassId || "")
          : classIdSelect.value;
      classIdSelect.disabled = false;
      classIdSelect.innerHTML = options.map(c =>
        `<option value="${c.id}" ${c.id === preferId ? "selected" : ""}>${escapeHtml(c.name)}</option>`
      ).join("");
      plannedWrap.classList.add("hidden");
    }
  }
  syncClassIdByStatus(true);
  $("#f_status").onchange = () => syncClassIdByStatus(false);

  // 파일 선택이든, 클립보드 붙여넣기든 동일하게 축소/미리보기 처리를 하기 위한 공용 함수
  async function setPhotoFromFile(file) {
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      pendingPhotoDataUrl = dataUrl;
      photoRemoved = false;
      const preview = $("#photoPreview");
      preview.src = dataUrl;
      preview.classList.remove("hidden");
      $("#photoPreviewPlaceholder").classList.add("hidden");
    } catch (err) {
      alert(`사진을 처리하는 중 오류가 발생했습니다: ${err.message || err}`);
    }
  }

  $("#f_photoFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await setPhotoFromFile(file);
  };

  // 동그란 사진 영역을 눌러도 실제로 뭔가 반응이 있어야 "여기다"라는 게 느껴지므로 포커스를 줌
  // (붙여넣기 자체는 문서 전체에서 감지하므로 어디를 클릭해도 동작하지만, 이렇게 하면 사용자가
  // "여기를 클릭하고 Ctrl+V" 흐름을 자연스럽게 따라오게 됨).
  $("#photoDropZone").onclick = () => $("#photoDropZone").focus();

  // 클립보드에 이미지가 복사되어 있을 때 Ctrl+V로 바로 등록. 이 모달이 열려있는 동안만 동작하도록,
  // 모달을 새로 열 때마다 이전에 등록된 리스너는 지우고 새로 등록함(중복 실행 방지).
  if (window._studentPhotoPasteHandler) {
    document.removeEventListener("paste", window._studentPhotoPasteHandler);
  }
  window._studentPhotoPasteHandler = async (e) => {
    if (!$("#f_photoFile")) return; // 이 모달이 이미 닫혔으면 무시
    const items = e.clipboardData?.items || [];
    const imageItem = Array.from(items).find(it => it.type.startsWith("image/"));
    if (!imageItem) {
      // 사진 영역에 포커스를 두고 Ctrl+V를 눌렀는데도 이미지를 못 찾은 경우, 콘솔에 원인 진단용 로그를 남김
      // (클립보드에 이미지가 아예 없거나, 브라우저가 인식하지 못하는 형식일 가능성이 높음).
      if (document.activeElement && document.activeElement.id === "photoDropZone") {
        console.warn("[사진 붙여넣기] 클립보드에서 이미지 데이터를 찾지 못했습니다.",
          "클립보드 항목:", Array.from(items).map(it => it.type));
      }
      return; // 복사한 게 이미지가 아니면(텍스트 등) 평소대로 붙여넣기 진행
    }
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) {
      console.warn("[사진 붙여넣기] 이미지 항목은 찾았지만 파일로 변환하지 못했습니다.");
      return;
    }
    await setPhotoFromFile(file);
  };
  document.addEventListener("paste", window._studentPhotoPasteHandler);

  $("#removePhotoBtn").onclick = () => {
    pendingPhotoDataUrl = null;
    photoRemoved = true;
    $("#photoPreview").classList.add("hidden");
    $("#photoPreviewPlaceholder").classList.remove("hidden");
  };

  $("#addGuardianBtn").onclick = () => {
    $("#guardianRows").insertAdjacentHTML("beforeend", guardianRowHtml("아버지", "", ""));
  };
  // 동적으로 추가되는 행도 한 번에 처리되도록 컨테이너에 이벤트 위임
  $("#guardianRows").addEventListener("click", (e) => {
    if (e.target.classList.contains("g_remove")) {
      e.target.closest(".guardian-row").remove();
    }
  });

  if (isEdit) {
    $("#deleteBtn").onclick = async () => {
      if (!confirm(`${student.name} 학생 정보를 삭제할까요?\n관련된 재적변동이력도 함께 삭제됩니다. (지난 출석 기록은 유지됩니다)`)) return;
      try {
        await deleteDoc(doc(db, "students", student.id));
        await deleteHistoryForStudent(student.id);
      } catch (err) {
        alert(`삭제 중 오류가 발생했습니다: ${err.message || err}\n(권한 문제일 수 있습니다. 담당 반이 맞는지 확인해주세요.)`);
        return;
      }
      await loadStudents(true);
      closeModal();
      renderStudentsTable();
    };
  }

  $("#saveBtn").onclick = async () => {
    const guardians = $all(".guardian-row", $("#guardianRows")).map(row => ({
      relation: row.querySelector(".g_relation").value,
      name: row.querySelector(".g_name").value.trim(),
      phone: row.querySelector(".g_phone").value.trim()
    })).filter(g => g.name || g.phone); // 이름/전화번호 둘 다 비어있는 빈 줄은 저장하지 않음

    const payload = {
      name: $("#f_name").value.trim(),
      classId: $("#f_classId").value,
      gender: $("#f_gender").value,
      status: $("#f_status").value,
      // "실제 학년(예정 반)"은 새친구 상태일 때만 의미가 있으므로, 그 외 상태로 저장될 때는 비워둠
      plannedClassId: $("#f_status").value === "new" ? ($("#f_plannedClassId")?.value || "") : "",
      joinDate: $("#f_joinDate").value,
      phone: $("#f_phone").value.trim(),
      school: $("#f_school").value.trim(),
      birthday: $("#f_birthday").value.trim(),
      address: $("#f_address").value.trim(),
      guardians,
      baptismStatus: $("#f_baptism").value,
      scholarships: $all(".f_scholarship_period", $("#scholarshipSection")).filter(cb => cb.checked).map(cb => cb.value),
      note: $("#f_note").value.trim(),
      order: student?.order ?? Date.now(),
      // 사진: "제거"를 눌렀으면 빈 문자열로, 새로 골랐으면 그 값으로, 안 건드렸으면 기존 값을 그대로 유지
      photoDataUrl: photoRemoved ? "" : (pendingPhotoDataUrl || student?.photoDataUrl || "")
    };
    if (!payload.name) { alert("이름을 입력해주세요."); return; }
    // 방어적 검증: 새친구반은 "새친구" 상태의 학생만 배정 가능(반대로도 마찬가지).
    // 화면에서 이미 선택지를 제한해두었지만, 혹시 모를 상태 불일치를 한 번 더 막아둠.
    if (payload.status !== "new" && payload.classId === "newcomer") {
      alert("새친구반은 '새친구' 상태의 학생만 배정할 수 있습니다. 실제 배정할 반을 선택해주세요.");
      return;
    }
    if (payload.status === "new" && !payload.plannedClassId) {
      if (!confirm("실제 학년(예정 반)을 선택하지 않았습니다. 나중에 재적으로 전환할 때 어느 반으로 보내야 할지 헷갈릴 수 있습니다. 이대로 저장할까요?")) return;
    }

    // 저장 중 오류(예: 사진이 너무 커서 문서 용량 제한을 초과하는 경우, 네트워크 문제, 권한 문제 등)가
    // 조용히 묻히지 않도록 반드시 사용자에게 알려줌. 이게 없으면 "저장했는데 반영이 안 됐다"처럼
    // 보이는 것과, 실제로 데이터가 깨져서 저장된 것을 구분할 수 없음.
    try {
      if (isEdit) {
        const prevStatus = student.status;
        const prevClassId = student.classId;
        await updateDoc(doc(db, "students", student.id), payload);
        if (prevStatus !== payload.status) {
          // 상태와 함께 반도 바뀐 경우(예: 새친구반 -> 재적으로 전환하며 학년반으로 이동), 이력 메모에
          // 반 이동 내역도 함께 남겨서 나중에 재적변동이력에서 언제 어느 반으로 옮겨졌는지 확인할 수 있게 함.
          const classMoveNote = prevClassId !== payload.classId
            ? ` (${classMap[prevClassId] || prevClassId} → ${classMap[payload.classId] || payload.classId})`
            : "";
          await addHistoryRecord({
            studentId: student.id, studentName: payload.name, classId: payload.classId,
            type: payload.status, date: todayISO(), note: `상태 변경: ${STUDENT_STATUS_LABEL[prevStatus] || prevStatus} → ${STUDENT_STATUS_LABEL[payload.status] || payload.status}${classMoveNote}`
          });
        }
      } else {
        const ref = await addDoc(collection(db, "students"), { ...payload, createdAt: serverTimestamp() });
        await addHistoryRecord({
          studentId: ref.id, studentName: payload.name, classId: payload.classId,
          type: payload.status, date: payload.joinDate, note: "신규 등록"
        });
      }
    } catch (err) {
      alert(`저장 중 오류가 발생했습니다: ${err.message || err}\n(사진 용량이 너무 크거나 네트워크 문제일 수 있습니다. 사진을 새로 붙여넣거나 파일을 바꿔서 다시 시도해주세요.)`);
      return;
    }
    await loadStudents(true);
    closeModal();
    renderStudentsTable();
  };
}

// "휴학"/"전출"은 예전 CSV/구글시트에 남아있을 수 있는 표현이라, 붙여넣었을 때도 "보류"로 인식되도록
// 하위호환으로 함께 매핑해둠 (실제 상태값은 5개: active/new/hold/removed/graduated).
const CSV_STATUS_MAP = {
  "재적": "active", "새친구": "new", "보류": "hold", "휴학": "hold", "전출": "hold", "제적": "removed",
  "졸업": "graduated"
};

// CSV 일괄등록 열 순서. 앞의 3개(이름/반이름/성별)만 필수이고 나머지는 전부 생략 가능
// (생략된 열은 빈 값으로 등록됨) — 한 줄에 이 열 개수보다 적게만 채워서 붙여넣어도 정상 동작함.
const BULK_IMPORT_COLUMNS = [
  "이름", "반이름", "성별", "상태", "등록일", "전화번호", "학교명", "생일", "주소",
  "보호자1관계", "보호자1이름", "보호자1전화", "보호자2관계", "보호자2이름", "보호자2전화", "비고"
];

function openBulkImportModal(visibleClasses) {
  openModal(`
    <h3>CSV 일괄 등록</h3>
    <p style="font-size:13px;color:#6b7280;">
      한 줄에 학생 한 명씩, 아래 순서로 붙여넣어주세요. 이름/반이름/성별 3개만 필수이고 나머지는 비워둬도 됩니다.<br/>
      구글시트/엑셀에서 여러 열을 그대로 복사해서 붙여넣어도 됩니다. (쉼표 또는 탭 구분 모두 지원, 주소 등에 쉼표가 들어있으면 탭 구분으로 붙여넣어주세요)<br/>
      <code>${BULK_IMPORT_COLUMNS.join(", ")}</code><br/>
      상태 열은 생략 가능하며, 생략 시 "재적"으로 등록됩니다. 새친구로 등록하려면 상태 칸에 "새친구"라고 적어주세요.<br/>
      <strong>새친구는 반이름 칸에 실제 학년(예: "중2")을 적어주세요</strong> — 상태가 "새친구"면 자동으로 새친구반에 등록되고, 반이름 칸에 적은 학년은 "실제 학년(예정 반)"으로 따로 저장되어 나중에 재적 전환 시 참고할 수 있습니다.<br/>
      등록일/생일은 모두 <code>YYYY-MM-DD</code> 형식으로 넣어주세요 (예: 2026-01-01). 등록일을 비워두면 오늘 날짜로 등록됩니다.<br/>
      예) <code>정현우,중1,남,재적,2026-01-01,010-1234-5678,광성중,2013-03-05,한빛마을 5단지,아버지,정광수,,어머니,김회선,010-4226-4639,</code>
    </p>
    <label>반 이름 매핑 참고</label>
    <p style="font-size:12px;color:#868e96;">${visibleClasses.map(c => c.name).join(", ")}</p>
    <textarea id="csvInput" rows="10" placeholder="정현우,중1,남,재적&#10;안다은,중1,여,재적&#10;나새롬,중1,여,새친구"></textarea>
    <div class="modal-actions">
      <button id="cancelBtn" class="btn">취소</button>
      <button id="importBtn" class="btn btn-primary">등록</button>
    </div>
    <p id="importMsg" style="font-size:13px;margin-top:8px;"></p>
  `);

  $("#cancelBtn").onclick = closeModal;
  $("#importBtn").onclick = async () => {
    const text = $("#csvInput").value.trim();
    if (!text) return;
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const nameToClassId = Object.fromEntries(visibleClasses.map(c => [c.name, c.id]));
    let success = 0, fail = 0;

    const failedLines = [];
    for (const line of lines) {
      const parts = parseDelimitedLine(line).map(p => p.trim());
      const [
        name, className, genderRaw, statusRaw, joinDateRaw, phone, school, birthday, address,
        g1relation, g1name, g1phone, g2relation, g2name, g2phone, note
      ] = parts;
      const gender = (genderRaw === "여" || genderRaw === "F") ? "F" : "M";
      const status = CSV_STATUS_MAP[statusRaw] || "active";
      // 새친구는 반이름 칸의 값과 무관하게 항상 새친구반으로 등록하고, 반이름 칸에 적힌 학년은
      // "실제 학년(예정 반)"으로 보존한다(반이름 칸에 이미 "새친구"라고 적었다면 예정 반은 비워둠).
      let classId, plannedClassId = "";
      if (status === "new") {
        classId = "newcomer";
        const maybeGradeId = nameToClassId[className];
        if (maybeGradeId && maybeGradeId !== "newcomer") plannedClassId = maybeGradeId;
      } else {
        classId = nameToClassId[className];
      }
      if (!name || !classId) { fail++; failedLines.push(line); continue; }
      // 등록일을 직접 지정하지 않았거나 형식이 이상하면(YYYY-MM-DD가 아니면) 오늘 날짜로 대체
      const joinDate = /^\d{4}-\d{2}-\d{2}$/.test(joinDateRaw || "") ? joinDateRaw : todayISO();
      // 보호자는 이름 또는 전화번호 중 하나라도 있으면 한 명으로 인정 (관계를 안 적었으면 순서대로 아버지/어머니로 기본 지정)
      const guardians = [];
      if (g1name || g1phone) guardians.push({ relation: g1relation || "아버지", name: g1name || "", phone: g1phone || "" });
      if (g2name || g2phone) guardians.push({ relation: g2relation || "어머니", name: g2name || "", phone: g2phone || "" });
      try {
        const ref = await addDoc(collection(db, "students"), {
          name, classId, plannedClassId, gender, status, joinDate,
          phone: phone || "", school: school || "", birthday: birthday || "", address: address || "",
          guardians, baptismStatus: "", scholarships: [], photoDataUrl: "",
          note: note || "",
          order: Date.now() + success, createdAt: serverTimestamp()
        });
        await addHistoryRecord({
          studentId: ref.id, studentName: name, classId,
          type: status, date: joinDate, note: "CSV 일괄등록"
        });
        success++;
      } catch (err) {
        fail++;
        failedLines.push(`${line} (오류: ${err.message || err})`);
      }
    }
    $("#importMsg").innerHTML = `${success}명 등록 완료${fail ? `, ${fail}건 실패` : ""}` +
      (failedLines.length ? `<br/><span style="color:#e03131;">실패 항목: ${failedLines.map(escapeHtml).join(" / ")}</span>` : "");
    await loadStudents(true);
    renderStudentsTable();
  };
}
