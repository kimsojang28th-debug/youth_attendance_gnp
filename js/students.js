import {
  db, collection, getDocs, addDoc, updateDoc, deleteDoc, doc, query, orderBy, serverTimestamp
} from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import {
  $, $all, escapeHtml, STUDENT_STATUS_LABEL, openModal, closeModal, todayISO, parseDelimitedLine, sortByName
} from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";
import { addHistoryRecord, deleteHistoryForStudent } from "./history.js";

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

export async function initStudentsView() {
  const classes = await loadClasses();
  const visibleClasses = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));

  const classFilter = $("#studentsClassFilter");
  classFilter.innerHTML = `<option value="all">전체 반</option>` +
    visibleClasses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  $("#studentsClassFilter").onchange = renderStudentsTable;
  $("#studentsStatusFilter").onchange = renderStudentsTable;
  $("#addStudentBtn").onclick = () => openStudentModal();
  $("#bulkImportBtn").onclick = () => openBulkImportModal(visibleClasses);

  await loadStudents(true);
  renderStudentsTable();
}


async function renderStudentsTable() {
  const classId = $("#studentsClassFilter").value;
  const status = $("#studentsStatusFilter").value;
  const classes = getClassesCache();
  const classMap = Object.fromEntries(classes.map(c => [c.id, c.name]));
  const allowed = isAdmin() ? null : new Set(currentUser.classIds);

  let list = _studentsCache.filter(s => {
    if (allowed && !allowed.has(s.classId)) return false;
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
        <th>이름</th><th>반</th><th>성별</th><th>상태</th><th>등록일</th><th>비고</th><th></th>
      </tr></thead>
      <tbody>
        ${list.map(s => `
          <tr data-id="${s.id}">
            <td><a href="#" class="student-name-link">${escapeHtml(s.name)}</a></td>
            <td>${escapeHtml(classMap[s.classId] || s.classId)}</td>
            <td>${s.gender === "F" ? "여" : "남"}</td>
            <td><span class="badge badge-${s.status}">${STUDENT_STATUS_LABEL[s.status] || s.status}</span></td>
            <td>${escapeHtml(s.joinDate || "")}</td>
            <td>${escapeHtml(s.note || "")}</td>
            <td><button class="btn btn-sm editStudentBtn">수정</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
    </div>
  `;

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
function openStudentProfileModal(student) {
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
      <div class="profile-field-row"><span class="profile-field-label">주소</span><span class="profile-field-value">${escapeHtml(student.address || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">등록일</span><span class="profile-field-value">${escapeHtml(student.joinDate || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">세례여부</span><span class="profile-field-value">${escapeHtml(student.baptismStatus || "-")}</span></div>
      <div class="profile-field-row"><span class="profile-field-label">장학금</span><span class="profile-field-value">${student.scholarship ? "수여" : "-"}</span></div>
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
      <button id="cancelBtn" class="btn btn-primary">닫기</button>
    </div>
  `, { wide: true });

  $("#cancelBtn").onclick = closeModal;
  $("#editFromProfileBtn").onclick = () => openStudentModal(student);
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

// 사진 파일을 최대 320px, JPEG 압축(quality 0.75)으로 축소해서 data URL 문자열로 변환.
// Firestore 문서 1개당 용량 제한(1MiB)에 안전하게 들어가도록 하기 위해 원본을 그대로 저장하지 않고
// 이렇게 축소함(보통 결과물이 수십 KB 수준). 별도의 Firebase Storage 설정 없이 학생 문서 안에 바로 저장됨.
function resizeImageToDataUrl(file, maxSize = 320, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("이미지를 불러올 수 없습니다."));
      img.onload = () => {
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
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function openStudentModal(student = null) {
  const classes = getClassesCache();
  const visible = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));
  const isEdit = !!student;

  let pendingPhotoDataUrl = null; // 사용자가 이번에 새로 고른 사진(아직 저장 전)
  let photoRemoved = false; // "사진 제거"를 눌렀는지

  openModal(`
    <h3>${isEdit ? "학생 정보 수정" : "학생 추가"}</h3>

    <label>프로필 사진</label>
    <div class="photo-upload-row">
      <img id="photoPreview" class="photo-preview ${student?.photoDataUrl ? "" : "hidden"}" src="${student?.photoDataUrl || ""}" />
      <div id="photoPreviewPlaceholder" class="photo-preview photo-preview-placeholder ${student?.photoDataUrl ? "hidden" : ""}">👤</div>
      <div>
        <input type="file" id="f_photoFile" accept="image/*" />
        <div><button type="button" id="removePhotoBtn" class="btn btn-sm" style="margin-top:6px;">사진 제거</button></div>
      </div>
    </div>
    <p style="font-size:12px;color:#868e96;margin:-4px 0 12px;">다른 곳에서 이미지를 복사한 뒤, 이 창 안에서 Ctrl+V(붙여넣기)로도 등록할 수 있습니다.</p>

    <label>이름</label>
    <input id="f_name" value="${escapeHtml(student?.name || "")}" />
    <label>반</label>
    <select id="f_classId">
      ${visible.map(c => `<option value="${c.id}" ${student?.classId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
    </select>
    <label>성별</label>
    <select id="f_gender">
      <option value="M" ${student?.gender === "M" ? "selected" : ""}>남</option>
      <option value="F" ${student?.gender === "F" ? "selected" : ""}>여</option>
    </select>
    <label>상태</label>
    <select id="f_status">
      <option value="active" ${student?.status === "active" ? "selected" : ""}>재적</option>
      <option value="new" ${student?.status === "new" ? "selected" : ""}>새친구</option>
      <option value="hold" ${student?.status === "hold" ? "selected" : ""}>보류</option>
      <option value="removed" ${student?.status === "removed" ? "selected" : ""}>제적</option>
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

    <label style="display:flex;align-items:center;gap:6px;margin-top:14px;">
      <input type="checkbox" id="f_scholarship" style="width:auto;" ${student?.scholarship ? "checked" : ""} /> 장학금 수여
    </label>

    <label>비고</label>
    <textarea id="f_note" rows="2">${escapeHtml(student?.note || "")}</textarea>
    <div class="modal-actions">
      ${isEdit ? `<button id="deleteBtn" class="btn btn-danger">삭제</button>` : ""}
      <button id="cancelBtn" class="btn">취소</button>
      <button id="saveBtn" class="btn btn-primary">저장</button>
    </div>
  `, { wide: true });

  $("#cancelBtn").onclick = closeModal;

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

  // 클립보드에 이미지가 복사되어 있을 때 Ctrl+V로 바로 등록. 이 모달이 열려있는 동안만 동작하도록,
  // 모달을 새로 열 때마다 이전에 등록된 리스너는 지우고 새로 등록함(중복 실행 방지).
  if (window._studentPhotoPasteHandler) {
    document.removeEventListener("paste", window._studentPhotoPasteHandler);
  }
  window._studentPhotoPasteHandler = async (e) => {
    if (!$("#f_photoFile")) return; // 이 모달이 이미 닫혔으면 무시
    const items = e.clipboardData?.items || [];
    const imageItem = Array.from(items).find(it => it.type.startsWith("image/"));
    if (!imageItem) return; // 복사한 게 이미지가 아니면(텍스트 등) 평소대로 붙여넣기 진행
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (file) await setPhotoFromFile(file);
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
      joinDate: $("#f_joinDate").value,
      phone: $("#f_phone").value.trim(),
      school: $("#f_school").value.trim(),
      birthday: $("#f_birthday").value.trim(),
      address: $("#f_address").value.trim(),
      guardians,
      baptismStatus: $("#f_baptism").value,
      scholarship: $("#f_scholarship").checked,
      note: $("#f_note").value.trim(),
      order: student?.order ?? Date.now(),
      // 사진: "제거"를 눌렀으면 빈 문자열로, 새로 골랐으면 그 값으로, 안 건드렸으면 기존 값을 그대로 유지
      photoDataUrl: photoRemoved ? "" : (pendingPhotoDataUrl || student?.photoDataUrl || "")
    };
    if (!payload.name) { alert("이름을 입력해주세요."); return; }

    if (isEdit) {
      const prevStatus = student.status;
      await updateDoc(doc(db, "students", student.id), payload);
      if (prevStatus !== payload.status) {
        await addHistoryRecord({
          studentId: student.id, studentName: payload.name, classId: payload.classId,
          type: payload.status, date: todayISO(), note: `상태 변경: ${STUDENT_STATUS_LABEL[prevStatus] || prevStatus} → ${STUDENT_STATUS_LABEL[payload.status] || payload.status}`
        });
      }
    } else {
      const ref = await addDoc(collection(db, "students"), { ...payload, createdAt: serverTimestamp() });
      await addHistoryRecord({
        studentId: ref.id, studentName: payload.name, classId: payload.classId,
        type: payload.status === "new" ? "new" : "transfer_in", date: payload.joinDate, note: "신규 등록"
      });
    }
    await loadStudents(true);
    closeModal();
    renderStudentsTable();
  };
}

// "휴학"/"전출"은 예전 CSV/구글시트에 남아있을 수 있는 표현이라, 붙여넣었을 때도 "보류"로 인식되도록
// 하위호환으로 함께 매핑해둠 (실제 상태값은 4개: active/new/hold/removed).
const CSV_STATUS_MAP = {
  "재적": "active", "새친구": "new", "보류": "hold", "휴학": "hold", "전출": "hold", "제적": "removed"
};

function openBulkImportModal(visibleClasses) {
  openModal(`
    <h3>CSV 일괄 등록</h3>
    <p style="font-size:13px;color:#6b7280;">
      한 줄에 학생 한 명씩, <code>이름,반이름,성별(남/여),상태(선택)</code> 형식으로 붙여넣어주세요.<br/>
      구글시트에서 열을 복사해서 그대로 붙여넣어도 됩니다. (쉼표 또는 탭 구분 모두 지원)<br/>
      상태 열은 생략 가능하며, 생략 시 "재적"으로 등록됩니다. 새친구로 등록하려면 상태 칸에 "새친구"라고 적어주세요.<br/>
      예) <code>정현우,중1,남,재적</code> / <code>나새롬,중1,여,새친구</code>
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
      const [name, className, genderRaw, statusRaw] = parts;
      const classId = nameToClassId[className];
      if (!name || !classId) { fail++; failedLines.push(line); continue; }
      const gender = (genderRaw === "여" || genderRaw === "F") ? "F" : "M";
      const status = CSV_STATUS_MAP[statusRaw] || "active";
      const joinDate = todayISO();
      try {
        const ref = await addDoc(collection(db, "students"), {
          name, classId, gender, status, joinDate, note: "",
          order: Date.now() + success, createdAt: serverTimestamp()
        });
        await addHistoryRecord({
          studentId: ref.id, studentName: name, classId,
          type: status === "new" ? "new" : "transfer_in", date: joinDate, note: "CSV 일괄등록"
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
