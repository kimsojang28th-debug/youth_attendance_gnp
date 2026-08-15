import {
  db, collection, getDocs, addDoc, updateDoc, deleteDoc, query, where, limit, orderBy, setDoc, doc
} from "./firebase-init.js";
import { $, escapeHtml, openModal, closeModal } from "./utils.js";
import { isAdmin } from "./auth.js";

let _classesCache = null;

export async function loadClasses(force = false) {
  if (_classesCache && !force) return _classesCache;
  const q = query(collection(db, "classes"), orderBy("order"));
  const snap = await getDocs(q);
  _classesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _classesCache;
}

export function getClassesCache() {
  return _classesCache || [];
}

export function getClassById(classId) {
  return (_classesCache || []).find(c => c.id === classId);
}

// 최초 1회, classes 컬렉션이 비어있을 때 기본 반 구성을 심어주는 헬퍼
// (관리자 콘솔에서 직접 실행하거나, 초기 세팅 시 한 번 호출)
export const DEFAULT_CLASSES = [
  { id: "mid1", name: "중1", grade: "중1", order: 1, teacherNames: [] },
  { id: "mid2", name: "중2", grade: "중2", order: 2, teacherNames: [] },
  { id: "mid3", name: "중3", grade: "중3", order: 3, teacherNames: [] },
  { id: "high1_m", name: "고1남", grade: "고1", order: 4, teacherNames: [] },
  { id: "high1_f", name: "고1여", grade: "고1", order: 5, teacherNames: [] },
  { id: "high2_m", name: "고2남", grade: "고2", order: 6, teacherNames: [] },
  { id: "high2_f", name: "고2여", grade: "고2", order: 7, teacherNames: [] },
  { id: "high3", name: "고3", grade: "고3", order: 8, teacherNames: [] },
  { id: "newcomer", name: "새친구", grade: "새친구", order: 9, teacherNames: [] }
];

export async function seedDefaultClassesIfEmpty() {
  const existing = await loadClasses(true);
  if (existing.length > 0) return existing;
  for (const c of DEFAULT_CLASSES) {
    await setDoc(doc(db, "classes", c.id), c);
  }
  return loadClasses(true);
}

/* ===================== 반 관리 화면 ===================== */
// 학생 재적부에서 학생을 추가/삭제하듯, 반도 직접 추가/삭제할 수 있는 화면.
// 반 추가/수정/삭제는 관리자(부장)만 가능 (firestore.rules의 classes 컬렉션 규칙과 동일하게 맞춤).

export async function initClassesView() {
  await loadClasses(true);
  renderClassesView();
}

function renderClassesView() {
  const classes = getClassesCache();
  const admin = isAdmin();
  const wrap = $("#view-classes");

  wrap.innerHTML = `
    <h2>반 관리</h2>
    ${admin
      ? `<div class="toolbar"><button id="addClassBtn" class="btn btn-primary">+ 반 추가</button></div>`
      : `<p class="dim-note" style="margin-bottom:12px;">반 추가/수정/삭제는 관리자(부장)만 할 수 있습니다.</p>`}
    <div class="table-scroll">
    <table>
      <thead><tr><th>반 이름</th><th>담당 선생님</th>${admin ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${classes.length ? classes.map(c => `
          <tr data-id="${c.id}">
            <td>${escapeHtml(c.name)}</td>
            <td>${(c.teacherNames && c.teacherNames.length) ? escapeHtml(c.teacherNames.join(", ")) : `<span class="dim-note">미배정</span>`}</td>
            ${admin ? `<td><button class="btn btn-sm editClassBtn">수정</button></td>` : ""}
          </tr>
        `).join("") : `<tr><td colspan="${admin ? 3 : 2}"><p class="list empty">등록된 반이 없습니다.</p></td></tr>`}
      </tbody>
    </table>
    </div>
  `;

  if (!admin) return;

  $("#addClassBtn").onclick = () => openClassModal();
  wrap.querySelectorAll(".editClassBtn").forEach(btn => {
    btn.onclick = (e) => {
      const id = e.target.closest("tr").dataset.id;
      const cls = getClassesCache().find(c => c.id === id);
      openClassModal(cls);
    };
  });
}

function openClassModal(cls = null) {
  const isEdit = !!cls;

  openModal(`
    <h3>${isEdit ? "반 정보 수정" : "반 추가"}</h3>
    <label>반 이름</label>
    <input id="f_className" value="${escapeHtml(cls?.name || "")}" placeholder="예: 중1" />
    <label>담당 선생님</label>
    <input id="f_teacherNames" value="${escapeHtml((cls?.teacherNames || []).join(", "))}" placeholder="예: 김선생, 이선생 (여러 명은 쉼표로 구분)" />
    <div class="modal-actions">
      ${isEdit ? `<button id="deleteClassBtn" class="btn btn-danger">삭제</button>` : ""}
      <button id="cancelBtn" class="btn">취소</button>
      <button id="saveClassBtn" class="btn btn-primary">저장</button>
    </div>
    <p id="classModalMsg" style="font-size:12.5px;color:#e03131;margin-top:8px;"></p>
  `);

  $("#cancelBtn").onclick = closeModal;

  if (isEdit) {
    $("#deleteClassBtn").onclick = async () => {
      // 소속 학생이 남아있는 반은 삭제하지 않도록 방어 (학생이 반 없이 붕 뜨는 것을 방지)
      const studentsSnap = await getDocs(query(collection(db, "students"), where("classId", "==", cls.id), limit(1)));
      if (!studentsSnap.empty) {
        $("#classModalMsg").textContent = "이 반에 소속된 학생이 있어 삭제할 수 없습니다. 먼저 재적부에서 학생을 다른 반으로 옮기거나 삭제해주세요.";
        return;
      }
      if (!confirm(`"${cls.name}" 반을 삭제할까요?`)) return;
      try {
        await deleteDoc(doc(db, "classes", cls.id));
      } catch (err) {
        $("#classModalMsg").textContent = `삭제 중 오류가 발생했습니다: ${err.message || err}`;
        return;
      }
      await loadClasses(true);
      closeModal();
      renderClassesView();
    };
  }

  $("#saveClassBtn").onclick = async () => {
    const name = $("#f_className").value.trim();
    if (!name) { $("#classModalMsg").textContent = "반 이름을 입력해주세요."; return; }
    const teacherNames = $("#f_teacherNames").value.split(",").map(s => s.trim()).filter(Boolean);

    try {
      if (isEdit) {
        await updateDoc(doc(db, "classes", cls.id), { name, teacherNames });
      } else {
        const maxOrder = getClassesCache().reduce((m, c) => Math.max(m, c.order || 0), 0);
        await addDoc(collection(db, "classes"), { name, teacherNames, grade: name, order: maxOrder + 1 });
      }
    } catch (err) {
      $("#classModalMsg").textContent = `저장 중 오류가 발생했습니다: ${err.message || err}`;
      return;
    }
    await loadClasses(true);
    closeModal();
    renderClassesView();
  };
}
