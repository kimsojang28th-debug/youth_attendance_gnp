import {
  db, collection, getDocs, addDoc, updateDoc, deleteDoc, query, where, limit, orderBy, setDoc, doc
} from "./firebase-init.js";
import { $, escapeHtml, openModal, closeModal } from "./utils.js";
import { isAdmin } from "./auth.js";
import { rosterForYear, listArchivedYears, getLiveYear, teacherNamesOfClass } from "./terms.js";
import { loadStudents } from "./students.js";
import { loadTeachers } from "./teachers.js";

let _classesCache = null;

export async function loadClasses(force = false) {
  if (_classesCache && !force) return _classesCache;
  const q = query(collection(db, "classes"), orderBy("order"));
  const snap = await getDocs(q);
  // 지난 학년도로 보관된 반(archived)은 현재 반 목록(출석체크/재적부/대시보드 등)에서 제외한다.
  // 지난 해 화면(연간출석부 등)은 terms.js 의 학년도 명부(rosterForYear)로 그린다.
  _classesCache = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.archived);

  // 2026-08-23(2차): 새친구반 관련 기능(재적부/대시보드/주간보고서)은 새친구반의 classId가 항상
  // "newcomer"라고 가정하고 만들어짐. 그런데 이 앱을 처음 도입한 시점이 새친구반 기능보다 훨씬 전이라,
  // classes 컬렉션에 id="newcomer" 문서가 없는 계정이 있을 수 있음(반이 이미 있던 기존 계정에는
  // 자동으로 추가되지 않고, 완전히 빈 상태에서 새로 시작하는 계정에만 기본값으로 심어짐).
  // 그래서 반 목록을 불러올 때 id="newcomer" 문서가 없으면 자동으로 하나 만들어서, 이후로는 새친구반
  // 관련 기능이 항상 정상 작동하도록 스스로 보정한다(관리자 계정으로 한 번만 로그인하면 영구적으로 해결됨 —
  // 반 컬렉션 쓰기 권한이 관리자에게만 있으므로 교사 계정으로는 이 보정이 조용히 건너뛰어짐).
  if (isAdmin() && !_classesCache.some(c => c.id === "newcomer")) {
    const maxOrder = _classesCache.reduce((m, c) => Math.max(m, c.order || 0), 0);
    const newcomerClass = { name: "새친구", grade: "새친구", order: maxOrder + 1, teacherNames: [] };
    try {
      await setDoc(doc(db, "classes", "newcomer"), newcomerClass);
      _classesCache.push({ id: "newcomer", ...newcomerClass });
    } catch (err) {
      console.error("새친구반(newcomer) 자동 생성 실패", err);
    }
  }

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

let _viewYear = null; // null = 현재 학년도, 숫자 = 지난 학년도(읽기 전용)

export async function initClassesView() {
  _viewYear = null;
  await Promise.all([loadClasses(true), loadStudents(true), loadTeachers(true)]);
  await renderClassesView();
}

async function renderClassesView() {
  const admin = isAdmin();
  const wrap = $("#view-classes");
  const past = !!_viewYear;
  const liveYear = await getLiveYear();
  const roster = await rosterForYear(_viewYear || liveYear);
  const classes = roster.classes;
  const students = roster.students.filter(s => ["active", "new", "hold"].includes(s.status));
  const archived = await listArchivedYears();
  const yearSel = archived.length
    ? `<select id="classesYearSelect"><option value="">현재 (${liveYear}학년도)</option>${archived.map(y => `<option value="${y}" ${_viewYear === y ? "selected" : ""}>${y}학년도 (보관)</option>`).join("")}</select>`
    : "";

  wrap.innerHTML = `
    <h2>반 관리</h2>
    <div class="toolbar">
      ${yearSel}
      ${admin && !past ? `<button id="addClassBtn" class="btn btn-primary">+ 반 추가</button>` : ""}
    </div>
    ${past ? `<p class="dim-note" style="margin-bottom:12px;">${_viewYear}학년도에 편성되었던 반입니다. 지난 학년도는 조회만 가능합니다.</p>`
      : admin ? `<p class="dim-note" style="margin-bottom:12px;">담당 선생님은 <b>교사현황</b>의 담당반 설정이 자동으로 표시됩니다. 학생의 반 이동은 재적부에서 합니다.</p>`
      : `<p class="dim-note" style="margin-bottom:12px;">반 추가/수정/삭제는 관리자(부장)만 할 수 있습니다.</p>`}
    <div class="table-scroll">
    <table>
      <thead><tr><th>반 이름</th><th>담당 선생님</th><th>학생</th>${admin && !past ? "<th></th>" : ""}</tr></thead>
      <tbody>
        ${classes.length ? classes.map(c => {
          const names = teacherNamesOfClass(roster, c);
          const cnt = students.filter(s => s.classId === c.id).length;
          return `
          <tr data-id="${c.id}">
            <td>${escapeHtml(c.name)}</td>
            <td>${names.length ? escapeHtml(names.join(", ")) : `<span class="dim-note">미배정</span>`}</td>
            <td>${cnt}명</td>
            ${admin && !past ? `<td><button class="btn btn-sm editClassBtn">수정</button></td>` : ""}
          </tr>`;
        }).join("") : `<tr><td colspan="4"><p class="list empty">등록된 반이 없습니다.</p></td></tr>`}
      </tbody>
    </table>
    </div>
  `;

  const ys = $("#classesYearSelect");
  if (ys) ys.onchange = async () => { _viewYear = ys.value ? Number(ys.value) : null; await renderClassesView(); };

  if (!admin || past) return;

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
    <p class="dim-note">담당 선생님은 교사현황의 담당반 설정에서 정합니다.</p>
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

    try {
      if (isEdit) {
        await updateDoc(doc(db, "classes", cls.id), { name });
      } else {
        const maxOrder = getClassesCache().reduce((m, c) => Math.max(m, c.order || 0), 0);
        await addDoc(collection(db, "classes"), { name, teacherNames: [], grade: name, order: maxOrder + 1 });
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
