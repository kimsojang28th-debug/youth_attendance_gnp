// ============================================================
// 새 학년도 편성 (관리자 전용)
// ------------------------------------------------------------
// 흐름: ① 반 구성 → ② 학생 배정 → ③ 교사 배정 → ④ 점검 → 초안은 자동/수동 저장(termDrafts/{연도})
//       → 12월 마지막 주일 이후 "전환 적용" → 지난 학년도 명부를 terms/{연도} 에 고정 보관하고
//         새 학년도 편성이 현재 데이터(classes/students/teachers)에 반영된다.
//       → 문제가 있으면 "직전 전환 되돌리기"(termUndo/{연도}에 적용 직전 값을 보관해 둠)
// 전환 전까지는 현재 학년도 데이터가 전혀 바뀌지 않는다.
// ============================================================
import {
  db, collection, doc, getDoc, getDocs, setDoc, deleteDoc, writeBatch, serverTimestamp, query, where, limit
} from "./firebase-init.js";
import { $, escapeHtml, openModal, closeModal, todayISO, sortByName } from "./utils.js";
import { isAdmin, isSystemAdmin, currentUser } from "./auth.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { loadTeachers, getTeachersCache } from "./teachers.js";
import { getLiveYear, loadSettings, invalidateTerms } from "./terms.js";
import { downloadBackup } from "./backup.js";
import { callFn } from "./functions-client.js";

const IN_SCOPE = ["active", "new", "hold"]; // 새 학년도 배정 대상 학생 상태
let S = null; // 화면 상태 { liveYear, year, draft, dirty, timer, savedAt, lastTransition, filter, selected }

const rid = () => Math.random().toString(36).slice(2, 9);
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
const digits = (v) => String(v || "").replace(/\D/g, "");
const wrap = () => $("#view-newyear");

// 전환 가능 시작일: 현재 학년도 12월 마지막 주일의 다음 날
function lastSundayISO(year) {
  const d = new Date(Date.UTC(year, 11, 31));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
function unlockISO(year) {
  const d = new Date(lastSundayISO(year) + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const isLocked = () => todayISO() < unlockISO(S.liveYear);
const fmtKo = (iso) => `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;

const liveClasses = () => [...getClassesCache()].filter(c => c.id !== "newcomer").sort(byOrder);
const rosterStudents = () => getStudentsCache().filter(s => IN_SCOPE.includes(s.status));
const activeTeachers = () => getTeachersCache().filter(t => !t.retired).sort(byOrder);

// 생년월일로 계산한 해당 학년도의 학년(참고용). 학교 학년은 출생연도 기준: (연도 - 출생연도 - 6)학년(초1=1 … 고3=12)
function gradeHint(s, year) {
  const y = parseInt(String(s.birthday || "").slice(0, 4), 10);
  if (!y) return "";
  const g = year - y - 6;
  if (g < 1) return "미취학";
  if (g <= 6) return `초${g}`;
  if (g <= 9) return `중${g - 6}`;
  if (g <= 12) return `고${g - 9}`;
  return "졸업 연령";
}

function defaultDraft() {
  const assign = {};
  rosterStudents().forEach(s => { if (s.classId === "newcomer") assign[s.id] = "newcomer"; });
  const teachers = {};
  activeTeachers().forEach(t => { teachers[t.id] = { active: true, classIds: [] }; });
  return { classes: [], assign, teachers, newTeachers: [] };
}

// 저장된 초안을 현재 명단에 맞게 정리(그 사이 입학/퇴원/교사 변동 반영)
function normalizeDraft(d) {
  const draft = { classes: d.classes || [], assign: d.assign || {}, teachers: d.teachers || {}, newTeachers: d.newTeachers || [] };
  const ids = new Set(rosterStudents().map(s => s.id));
  Object.keys(draft.assign).forEach(sid => { if (!ids.has(sid)) delete draft.assign[sid]; });
  const classIds = new Set(draft.classes.map(c => c.id));
  Object.entries(draft.assign).forEach(([sid, v]) => { if (v && v !== "graduate" && v !== "newcomer" && !classIds.has(v)) delete draft.assign[sid]; });
  activeTeachers().forEach(t => { if (!draft.teachers[t.id]) draft.teachers[t.id] = { active: true, classIds: [] }; });
  Object.keys(draft.teachers).forEach(tid => { if (!activeTeachers().some(t => t.id === tid)) delete draft.teachers[tid]; });
  Object.values(draft.teachers).forEach(t => { t.classIds = (t.classIds || []).filter(id => classIds.has(id)); });
  draft.newTeachers.forEach(t => { t.classIds = (t.classIds || []).filter(id => classIds.has(id)); });
  return draft;
}

export async function initNewYearView() {
  const el = wrap();
  if (!isAdmin()) {
    el.innerHTML = `<h2>새 학년도 편성</h2><p class="dim-note">관리자만 사용할 수 있습니다.</p>`;
    return;
  }
  el.innerHTML = `<h2>새 학년도 편성</h2><p class="dim-note">불러오는 중...</p>`;
  await Promise.all([loadClasses(true), loadStudents(true), loadTeachers(true)]);
  const settings = await loadSettings(true);
  const liveYear = await getLiveYear();
  const year = liveYear + 1;

  let draft = null, savedAt = null;
  try {
    const snap = await getDoc(doc(db, "termDrafts", String(year)));
    if (snap.exists()) { draft = normalizeDraft(snap.data()); savedAt = snap.data().updatedAt || true; }
  } catch (err) {
    el.innerHTML = `<h2>새 학년도 편성</h2><p class="list empty" style="color:#e03131;">초안을 불러오지 못했습니다. 보안 규칙(termDrafts)이 아직 적용되지 않았을 수 있습니다.<br>${escapeHtml(err.message || String(err))}</p>`;
    return;
  }
  S = {
    liveYear, year, draft: draft || defaultDraft(), dirty: false, timer: null, savedAt: savedAt ? new Date() : null,
    hasSaved: !!draft, lastTransition: settings.lastTransition || null, sort: "grade", filter: { cls: "all", onlyUn: false }, selected: new Set()
  };
  render();
}

// ---------------------------------------------------------------------------
// 초안 저장 (자동 저장 + 수동 저장)
// ---------------------------------------------------------------------------
function markDirty() {
  S.dirty = true;
  showSaveState();
  clearTimeout(S.timer);
  S.timer = setTimeout(() => saveDraft(true), 2500);
}

async function saveDraft(silent = false) {
  clearTimeout(S.timer);
  const data = JSON.parse(JSON.stringify(S.draft));
  try {
    await setDoc(doc(db, "termDrafts", String(S.year)), { ...data, year: S.year, updatedAt: serverTimestamp(), updatedBy: currentUser.name || "" });
    S.dirty = false; S.savedAt = new Date(); S.hasSaved = true;
    showSaveState(silent ? "자동 저장됨" : "저장했습니다");
  } catch (err) {
    console.error("초안 저장 실패", err);
    showSaveState("저장 실패: " + (err.message || err), true);
    throw err;
  }
}

function showSaveState(text, isErr = false) {
  const el = $("#nwSaveState");
  if (!el) return;
  const t = S.savedAt ? S.savedAt.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "";
  el.style.color = isErr ? "#e03131" : "";
  el.textContent = isErr ? text : (S.dirty ? "저장되지 않은 변경이 있습니다 (잠시 후 자동 저장)" : (text ? `${text} ${t}` : (S.hasSaved ? `저장된 초안이 있습니다 ${t}` : "아직 저장된 초안이 없습니다")));
}

// ---------------------------------------------------------------------------
// 분석(점검)
// ---------------------------------------------------------------------------
function analyze() {
  const d = S.draft;
  const students = rosterStudents();
  const blockers = [], warnings = [];
  const unassigned = students.filter(s => !d.assign[s.id]);
  const names = d.classes.map(c => (c.name || "").trim());
  if (!d.classes.length) blockers.push("새 학년도 반이 하나도 없습니다. ① 반 구성에서 반을 만들어주세요.");
  if (names.some(n => !n)) blockers.push("이름이 비어 있는 반이 있습니다.");
  const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (dup.length) blockers.push(`같은 이름의 반이 있습니다: ${[...new Set(dup)].join(", ")}`);
  if (unassigned.length) blockers.push(`배정하지 않은 학생이 ${unassigned.length}명 있습니다.`);
  d.newTeachers.forEach((t, i) => {
    if (!(t.name || "").trim()) blockers.push(`새 교사 ${i + 1}번의 이름이 비어 있습니다.`);
    else if (digits(t.phone).length < 10) blockers.push(`새 교사 "${t.name}"의 연락처를 입력해주세요(로그인에 필요합니다).`);
  });
  const perClass = d.classes.map(c => {
    const kids = students.filter(s => d.assign[s.id] === c.id);
    const tNames = [
      ...activeTeachers().filter(t => d.teachers[t.id]?.active && (d.teachers[t.id].classIds || []).includes(c.id)).map(t => t.name),
      ...d.newTeachers.filter(t => (t.classIds || []).includes(c.id) && (t.name || "").trim()).map(t => `${t.name.trim()}(신규)`)
    ];
    if (!kids.length && (c.name || "").trim()) warnings.push(`"${c.name}" 반에 배정된 학생이 없습니다.`);
    if (!tNames.length && (c.name || "").trim()) warnings.push(`"${c.name}" 반에 담당 교사가 없습니다.`);
    return { c, kids, tNames };
  });
  const freeTeachers = activeTeachers().filter(t => d.teachers[t.id]?.active && !(d.teachers[t.id].classIds || []).length);
  if (freeTeachers.length) warnings.push(`담당반이 없는 교사: ${freeTeachers.map(t => t.name).join(", ")}`);
  return {
    blockers, warnings, perClass, unassigned,
    graduating: students.filter(s => d.assign[s.id] === "graduate"),
    staying: students.filter(s => d.assign[s.id] === "newcomer"),
    retiring: activeTeachers().filter(t => !d.teachers[t.id]?.active),
    total: students.length
  };
}

function summaryHtml() {
  const a = analyze();
  const rows = a.perClass.map(({ c, kids, tNames }) => `
    <tr><td><b>${escapeHtml(c.name || "(이름 없음)")}</b></td><td>${kids.length}명</td><td>${tNames.length ? escapeHtml(tNames.join(", ")) : `<span class="dim-note">담당 교사 없음</span>`}</td></tr>`).join("");
  return `
    <div class="nw-sum-grid">
      <div><b>${a.total}</b><span>배정 대상 학생</span></div>
      <div><b>${a.graduating.length}</b><span>졸업</span></div>
      <div><b>${a.staying.length}</b><span>새친구 유지</span></div>
      <div class="${a.unassigned.length ? "bad" : ""}"><b>${a.unassigned.length}</b><span>미배정</span></div>
      <div><b>${a.retiring.length}</b><span>퇴임 교사</span></div>
      <div><b>${S.draft.newTeachers.length}</b><span>신규 교사</span></div>
    </div>
    ${a.perClass.length ? `<div class="table-scroll"><table class="nw-table"><thead><tr><th>${S.year} 반</th><th>학생</th><th>담당 교사</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    ${a.blockers.length ? `<ul class="nw-list bad">${a.blockers.map(m => `<li>⛔ ${escapeHtml(m)}</li>`).join("")}</ul>` : `<p class="nw-ok">✅ 전환에 필요한 항목은 모두 채워졌습니다.</p>`}
    ${a.warnings.length ? `<ul class="nw-list warn">${[...new Set(a.warnings)].map(m => `<li>⚠️ ${escapeHtml(m)}</li>`).join("")}</ul>` : ""}
  `;
}

function updateSummary() {
  const el = $("#nwSummary");
  if (el) el.innerHTML = summaryHtml();
  const btn = $("#nwApplyBtn");
  if (btn) btn.disabled = analyze().blockers.length > 0 || isLocked();
  const ln = $("#nwLockNote");
  if (ln) ln.innerHTML = isLocked()
    ? `🔒 ${S.liveYear}년 12월 마지막 주일(${fmtKo(lastSundayISO(S.liveYear))}) 출석 입력이 끝난 뒤, <b>${fmtKo(unlockISO(S.liveYear))}부터</b> 전환할 수 있습니다.`
    : "";
  // 반 구성 표의 학생 수/담당 교사 칸
  const a = analyze();
  a.perClass.forEach(({ c, kids, tNames }) => {
    const el1 = document.querySelector(`[data-cnt="${c.id}"]`);
    if (el1) el1.textContent = `${kids.length}명`;
    const el2 = document.querySelector(`[data-tn="${c.id}"]`);
    if (el2) el2.textContent = tNames.join(", ");
  });
}

// ---------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------
// 학년 순서: 초 < 중1~3 < 고1~3 < (학년 표시 없는 반: 반 관리 순서) < 새친구
function classRank(c) {
  if (!c || c.id === "newcomer") return 99;
  const n = c.name || "";
  let m = n.match(/초\s*([1-6])/); if (m) return Number(m[1]) / 10;
  m = n.match(/중\s*([1-3])/); if (m) return 1 + Number(m[1]);
  m = n.match(/고\s*([1-3])/); if (m) return 4 + Number(m[1]);
  return 20 + (c.order || 0) / 100;
}
const allCurrent = () => [...liveClasses(), { id: "newcomer", name: "새친구", order: 999 }].sort((a, b) => (classRank(a) - classRank(b)) || ((a.order || 0) - (b.order || 0)) || String(a.id).localeCompare(String(b.id)));

function destOptions(sel, withBlank = "— 선택 —", mixedLabel = "") {
  const d = S.draft;
  return `<option value="">${withBlank}</option>` +
    (mixedLabel ? `<option value="__mixed" selected disabled>${mixedLabel}</option>` : "") +
    d.classes.map(c => `<option value="${c.id}" ${sel === c.id ? "selected" : ""}>${escapeHtml(c.name || "(이름 없음)")}</option>`).join("") +
    `<option value="newcomer" ${sel === "newcomer" ? "selected" : ""}>새친구 유지</option>` +
    `<option value="graduate" ${sel === "graduate" ? "selected" : ""}>졸업</option>`;
}

const ddLabel = (ids) => {
  const names = S.draft.classes.filter(c => (ids || []).includes(c.id)).map(c => c.name || "(이름 없음)");
  return names.length ? names.join(", ") : "선택 안 함";
};
function classCheckboxes(classIds, attrs) {
  if (!S.draft.classes.length) return `<span class="dim-note">반을 먼저 만드세요</span>`;
  return `<details class="nw-dd"><summary>담당반: <b>${escapeHtml(ddLabel(classIds))}</b></summary><div class="nw-dd-list">` +
    S.draft.classes.map(c => `<label class="class-check"><input type="checkbox" ${attrs} data-cid="${c.id}" ${(classIds || []).includes(c.id) ? "checked" : ""}> ${escapeHtml(c.name || "(이름 없음)")}</label>`).join("") +
    `</div></details>`;
}

function render() {
  const y = window.scrollY;
  const d = S.draft;
  const live = liveClasses();
  const cur = (id) => (getClassesCache().find(c => c.id === id) || {}).name || "";
  const cmap = new Map(allCurrent().map(c => [c.id, c]));
  const students = rosterStudents().sort((a, b) => (classRank(cmap.get(a.classId)) - classRank(cmap.get(b.classId))) || ((cmap.get(a.classId)?.order || 0) - (cmap.get(b.classId)?.order || 0)) || String(a.classId).localeCompare(String(b.classId)) || (a.name || "").localeCompare(b.name || "", "ko"));
  const shown = students.filter(s => (S.filter.cls === "all" || s.classId === S.filter.cls) && (!S.filter.onlyUn || !d.assign[s.id]));
  const lt = S.lastTransition;

  wrap().innerHTML = `
    <h2>${S.year} 학년도 편성 <span class="dim-note" style="font-size:.7em;">(현재 ${S.liveYear} 학년도 운영 중)</span></h2>
    <div class="nw-intro">
      <p>전환 전에는 현재 ${S.liveYear} 학년도 데이터가 <b>전혀 바뀌지 않습니다.</b> 총회 후 미리 입력해 두고, ${S.liveYear}년 12월 마지막 주일 출석 입력을 마친 뒤 <b>전환 적용</b>을 누르세요. ${S.liveYear} 학년도 명부는 그대로 보관되어 학년도 선택으로 언제든 볼 수 있습니다.</p>
      <div class="nw-actions">
        <button class="btn btn-secondary" id="nwBackupBtn">💾 백업 내려받기</button>
        <button class="btn" id="nwSaveBtn">초안 저장</button>
        <span class="dim-note" id="nwSaveState"></span>
      </div>
    </div>

    <section class="nw-sec">
      <h3>① ${S.year} 반 구성</h3>
      <div class="nw-actions">
        <button class="btn btn-secondary" id="nwAddClass">+ 반 추가</button>
        <button class="btn btn-secondary" id="nwImportClasses">현재 반 이름 가져오기</button>
      </div>
      ${d.classes.length ? `<div class="table-scroll"><table class="nw-table"><thead><tr><th>순서</th><th>반 이름</th><th>학생</th><th>담당 교사</th><th></th></tr></thead><tbody>
        ${d.classes.map((c, i) => `<tr>
          <td class="nw-ord"><button class="btn-mini" data-up="${i}" ${i === 0 ? "disabled" : ""}>▲</button><button class="btn-mini" data-down="${i}" ${i === d.classes.length - 1 ? "disabled" : ""}>▼</button></td>
          <td><input type="text" class="nw-cname" data-cid="${c.id}" value="${escapeHtml(c.name || "")}" placeholder="예: 고2 연합반"></td>
          <td data-cnt="${c.id}"></td><td data-tn="${c.id}" class="dim-note"></td>
          <td><button class="btn-mini" data-delclass="${c.id}">삭제</button></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="dim-note">아직 반이 없습니다. "+ 반 추가" 또는 "현재 반 이름 가져오기"를 눌러주세요.</p>`}
    </section>

    <section class="nw-sec">
      <h3>② 학생 배정 <span class="dim-note">(대상 ${students.length}명)</span></h3>
      <p class="dim-note">현재 반 전체를 한 번에 옮기고, 예외만 아래 표에서 개별로 고치세요. 새친구는 기본이 "새친구 유지"이며, 교사가 나중에 반을 정해 옮길 수 있습니다.</p>
      <div class="table-scroll"><table class="nw-table"><thead><tr><th>현재 반</th><th>인원</th><th>일괄 지정 (고르면 반 전체에 적용)</th></tr></thead><tbody>
        ${allCurrent().map(c => {
          const kids = students.filter(s => s.classId === c.id);
          if (!kids.length) return "";
          const vals = kids.map(s => d.assign[s.id] || "");
          const done = vals.filter(Boolean).length;
          const uniq = [...new Set(vals)];
          const same = uniq.length === 1 ? uniq[0] : "";
          const mixed = uniq.length > 1 ? `개별 지정됨 (${uniq.filter(Boolean).length}곳${vals.includes("") ? " + 미배정" : ""})` : "";
          return `<tr><td>${escapeHtml(c.name)}</td><td>${kids.length}명 <span class="dim-note">(배정 ${done}/${kids.length})</span></td><td><select data-mapfrom="${c.id}" class="${same ? "nw-picked" : ""}">${destOptions(same, "일괄 지정…", mixed)}</select></td></tr>`;
        }).join("")}
      </tbody></table></div>

      <div class="nw-filter">
        <select id="nwSort"><option value="grade" ${S.sort !== "name" ? "selected" : ""}>학년순 (중1→고3)</option><option value="name" ${S.sort === "name" ? "selected" : ""}>가나다순</option></select>
        <select id="nwFilterCls"><option value="all">현재 반: 전체</option>${allCurrent().map(c => `<option value="${c.id}" ${S.filter.cls === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select>
        <label><input type="checkbox" id="nwOnlyUn" ${S.filter.onlyUn ? "checked" : ""}> 미배정만</label>
        <span class="nw-bulk"><select id="nwBulkDest">${destOptions("", "선택한 학생을…")}</select><button class="btn btn-secondary" id="nwBulkBtn">적용</button></span>
      </div>
      <div class="table-scroll"><table class="nw-table nw-stu"><thead><tr><th><input type="checkbox" id="nwAll"></th><th>이름</th><th>현재 반</th><th>${S.year} 학년(생일 기준)</th><th>${S.year} 배정</th></tr></thead><tbody>
        ${(S.sort === "name" ? [...shown].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko")) : shown).map((s, i, arr) => `${S.sort !== "name" && (i === 0 || arr[i - 1].classId !== s.classId) ? `<tr class="nw-grp"><td colspan="5">${escapeHtml(cur(s.classId) || (s.classId === "newcomer" ? "새친구" : "반 없음"))} <span class="dim-note">(${arr.filter(x => x.classId === s.classId).length}명)</span></td></tr>` : ""}<tr class="${d.assign[s.id] ? "" : "nw-un"}">
          <td><input type="checkbox" data-pick="${s.id}" ${S.selected.has(s.id) ? "checked" : ""}></td>
          <td>${escapeHtml(s.name || "")}</td><td>${escapeHtml(cur(s.classId) || (s.classId === "newcomer" ? "새친구" : ""))}</td>
          <td class="dim-note">${gradeHint(s, S.year)}</td>
          <td><select data-stu="${s.id}">${destOptions(d.assign[s.id] || "")}</select></td></tr>`).join("") || `<tr><td colspan="5" class="dim-note">해당 학생이 없습니다.</td></tr>`}
      </tbody></table></div>
    </section>

    <section class="nw-sec">
      <h3>③ 교사 배정</h3>
      <div class="table-scroll"><table class="nw-table"><thead><tr><th>교사</th><th>계속 활동</th><th>${S.year} 담당반</th></tr></thead><tbody>
        ${activeTeachers().map(t => { const v = d.teachers[t.id] || { active: true, classIds: [] }; return `<tr class="${v.active ? "" : "nw-off"}">
          <td>${escapeHtml(t.name)}</td>
          <td><label><input type="checkbox" data-tact="${t.id}" ${v.active ? "checked" : ""}> 계속</label></td>
          <td>${v.active ? classCheckboxes(v.classIds, `data-tcls="${t.id}"`) : `<span class="dim-note">퇴임 처리 (로그인 중지, 기록은 보관)</span>`}</td></tr>`; }).join("")}
      </tbody></table></div>
      <h4>새로 들어오는 교사</h4>
      ${d.newTeachers.map((t, i) => `<div class="nw-newt">
        <input type="text" placeholder="이름" data-nt="name" data-i="${i}" value="${escapeHtml(t.name || "")}">
        <select data-nt="gender" data-i="${i}"><option value="">성별</option><option value="남" ${t.gender === "남" ? "selected" : ""}>남</option><option value="여" ${t.gender === "여" ? "selected" : ""}>여</option></select>
        <input type="tel" placeholder="연락처 (로그인용)" data-nt="phone" data-i="${i}" value="${escapeHtml(t.phone || "")}">
        <div>${classCheckboxes(t.classIds, `data-ntcls="${i}"`)}</div>
        <button class="btn-mini" data-delnt="${i}">삭제</button></div>`).join("")}
      <button class="btn btn-secondary" id="nwAddTeacher">+ 새 교사 추가</button>
    </section>

    <section class="nw-sec">
      <h3>④ 점검 및 전환</h3>
      <div id="nwSummary"></div>
      <div class="nw-actions">
        <button class="btn" id="nwApplyBtn">${S.year} 학년도로 전환 적용…</button>
        ${isSystemAdmin() ? `<button class="btn btn-secondary hidden" id="nwForceBtn">잠금 무시하고 전환 (시스템 관리자)…</button>` : ""}
      </div>
      <p class="dim-note" id="nwLockNote"></p>
    </section>

    ${lt && lt.year ? `<section class="nw-sec"><h3>되돌리기</h3>
      <p class="dim-note">직전 전환: ${lt.year} 학년도 (${escapeHtml(lt.appliedBy || "")}). 전환 직후 문제가 있을 때만 사용하세요. 새 학년도 출석을 이미 입력했다면 그 출석은 새 반 기준이라 신중해야 합니다.</p>
      <button class="btn btn-secondary" id="nwUndoBtn">직전 전환 되돌리기…</button></section>` : ""}
  `;
  updateSummary();
  showSaveState();
  bind();
  window.scrollTo(0, y);
}

function bind() {
  const d = S.draft, root = wrap();
  const change = () => { markDirty(); updateSummary(); };
  const full = () => { markDirty(); render(); };
  const q = (s) => root.querySelectorAll(s);

  $("#nwBackupBtn").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "백업 중...";
    try { const r = await downloadBackup({}); alert(`백업 완료 (${r.counts ? Object.values(r.counts).reduce((a, b) => a + b, 0) : 0}건)${r.failed && r.failed.length ? "\n실패: " + r.failed.join(", ") : ""}`); }
    catch (err) { alert("백업 실패: " + (err.message || err)); }
    e.target.disabled = false; e.target.textContent = "💾 백업 내려받기";
  };
  $("#nwSaveBtn").onclick = async () => { try { await saveDraft(false); } catch (err) { alert("저장 실패: " + (err.message || err)); } };

  $("#nwAddClass").onclick = () => { d.classes.push({ id: "c" + String(S.year).slice(2) + "_" + rid(), name: "" }); full(); };
  $("#nwImportClasses").onclick = () => {
    if (d.classes.length && !confirm("현재 만든 반 목록 뒤에 현재 반 이름을 추가합니다. 계속할까요?")) return;
    liveClasses().forEach(c => d.classes.push({ id: "c" + String(S.year).slice(2) + "_" + rid(), name: c.name }));
    full();
  };
  q("[data-up]").forEach(b => b.onclick = () => { const i = +b.dataset.up; [d.classes[i - 1], d.classes[i]] = [d.classes[i], d.classes[i - 1]]; full(); });
  q("[data-down]").forEach(b => b.onclick = () => { const i = +b.dataset.down; [d.classes[i + 1], d.classes[i]] = [d.classes[i], d.classes[i + 1]]; full(); });
  q("[data-delclass]").forEach(b => b.onclick = () => {
    const id = b.dataset.delclass;
    if (!confirm("이 반을 삭제할까요? 이 반으로 배정한 학생은 미배정으로 돌아갑니다.")) return;
    d.classes = d.classes.filter(c => c.id !== id);
    Object.keys(d.assign).forEach(k => { if (d.assign[k] === id) delete d.assign[k]; });
    Object.values(d.teachers).forEach(t => t.classIds = (t.classIds || []).filter(x => x !== id));
    d.newTeachers.forEach(t => t.classIds = (t.classIds || []).filter(x => x !== id));
    full();
  });
  q(".nw-cname").forEach(inp => inp.oninput = () => { d.classes.find(c => c.id === inp.dataset.cid).name = inp.value; change(); });
  // 반 이름 입력 중에는 목록을 다시 그리지 않고, 이동할 때 선택지만 갱신
  q(".nw-cname").forEach(inp => inp.onchange = () => render());

  q("[data-mapfrom]").forEach(sel => sel.onchange = () => {
    if (!sel.value || sel.value === "__mixed") return;
    rosterStudents().filter(s => s.classId === sel.dataset.mapfrom).forEach(s => { d.assign[s.id] = sel.value; });
    full();
  });
  $("#nwFilterCls").onchange = (e) => { S.filter.cls = e.target.value; render(); };
  $("#nwSort").onchange = (e) => { S.sort = e.target.value; render(); };
  $("#nwOnlyUn").onchange = (e) => { S.filter.onlyUn = e.target.checked; render(); };
  q("[data-stu]").forEach(sel => sel.onchange = () => { if (sel.value) d.assign[sel.dataset.stu] = sel.value; else delete d.assign[sel.dataset.stu]; sel.closest("tr").classList.toggle("nw-un", !sel.value); change(); });
  q("[data-pick]").forEach(c => c.onchange = () => { c.checked ? S.selected.add(c.dataset.pick) : S.selected.delete(c.dataset.pick); });
  $("#nwAll").onchange = (e) => { q("[data-pick]").forEach(c => { c.checked = e.target.checked; e.target.checked ? S.selected.add(c.dataset.pick) : S.selected.delete(c.dataset.pick); }); };
  $("#nwBulkBtn").onclick = () => {
    const v = $("#nwBulkDest").value;
    if (!v) return alert("옮길 곳을 선택해주세요.");
    if (!S.selected.size) return alert("학생을 먼저 체크해주세요.");
    S.selected.forEach(id => { d.assign[id] = v; });
    S.selected.clear();
    full();
  };

  q("[data-tact]").forEach(c => c.onchange = () => { d.teachers[c.dataset.tact].active = c.checked; full(); });
  q("[data-tcls]").forEach(c => c.onchange = () => {
    const t = d.teachers[c.dataset.tcls], id = c.dataset.cid;
    t.classIds = c.checked ? [...new Set([...(t.classIds || []), id])] : (t.classIds || []).filter(x => x !== id);
    c.closest("details").querySelector("summary b").textContent = ddLabel(t.classIds);
    change();
  });
  $("#nwAddTeacher").onclick = () => { d.newTeachers.push({ id: "nt_" + rid(), name: "", gender: "", phone: "", classIds: [] }); full(); };
  q("[data-delnt]").forEach(b => b.onclick = () => { d.newTeachers.splice(+b.dataset.delnt, 1); full(); });
  q("[data-nt]").forEach(inp => { const h = () => { d.newTeachers[+inp.dataset.i][inp.dataset.nt] = inp.value; change(); }; inp.oninput = h; inp.onchange = h; });
  q("[data-ntcls]").forEach(c => c.onchange = () => {
    const t = d.newTeachers[+c.dataset.ntcls], id = c.dataset.cid;
    t.classIds = c.checked ? [...new Set([...(t.classIds || []), id])] : (t.classIds || []).filter(x => x !== id);
    c.closest("details").querySelector("summary b").textContent = ddLabel(t.classIds);
    change();
  });

  $("#nwApplyBtn").onclick = () => openApplyModal(false);
  const fb = $("#nwForceBtn");
  if (fb) {
    fb.classList.toggle("hidden", !isLocked());
    fb.onclick = () => {
      if (!confirm(`아직 전환 가능일(${fmtKo(unlockISO(S.liveYear))}) 전입니다.\n${S.liveYear}년 마지막 주일 출석을 입력하기 전에 전환하면 그 출석이 새 반 기준으로 들어갑니다.\n그래도 진행할까요?`)) return;
      openApplyModal(true);
    };
  }
  const u = $("#nwUndoBtn");
  if (u) u.onclick = undoTransition;
}

// ---------------------------------------------------------------------------
// 전환 적용
// ---------------------------------------------------------------------------
async function openApplyModal(force = false) {
  const a = analyze();
  if (a.blockers.length) return alert("먼저 점검 항목을 해결해주세요.");
  if (isLocked() && !force) return alert(`${fmtKo(unlockISO(S.liveYear))}부터 전환할 수 있습니다.`);
  // 마지막 주일 출석이 입력되어 있는지 확인
  let noAtt = false;
  try {
    const r = await getDocs(query(collection(db, "attendance"), where("date", "==", lastSundayISO(S.liveYear)), limit(1)));
    noAtt = r.empty;
  } catch (e) { /* 확인 실패 시 경고 생략 */ }
  openModal(`
    <h3>${S.year} 학년도로 전환</h3>
    <p>지금부터 모든 화면이 <b>${S.year} 학년도 편성</b> 기준으로 바뀝니다. ${S.liveYear} 학년도 명부는 그대로 보관됩니다.</p>
    <ul class="nw-list"><li>학생 ${a.total}명 중 졸업 ${a.graduating.length}명, 새친구 유지 ${a.staying.length}명</li><li>새 학년도 반 ${S.draft.classes.length}개</li><li>퇴임 교사 ${a.retiring.length}명, 신규 교사 ${S.draft.newTeachers.length}명</li></ul>
    ${noAtt ? `<ul class="nw-list bad"><li>⛔ ${fmtKo(lastSundayISO(S.liveYear))}(마지막 주일) 출석 기록이 하나도 없습니다. 입력을 깜빡하지 않았는지 확인하세요. 전환 후에는 지난 학년도 출석을 관리자만 고칠 수 있습니다.</li></ul>` : ""}
    ${a.warnings.length ? `<ul class="nw-list warn">${[...new Set(a.warnings)].map(m => `<li>⚠️ ${escapeHtml(m)}</li>`).join("")}</ul>` : ""}
    <p class="dim-note">확인을 위해 <b>${S.year}</b> 를 입력해주세요. (백업을 먼저 받아 두는 것을 권장합니다)</p>
    <input type="text" id="nwConfirmYear" inputmode="numeric" placeholder="${S.year}">
    <div class="modal-actions"><button class="btn btn-secondary" id="nwCancel">취소</button><button class="btn" id="nwGo">전환 적용</button></div>`);
  $("#nwCancel").onclick = closeModal;
  $("#nwGo").onclick = async () => {
    if ($("#nwConfirmYear").value.trim() !== String(S.year)) return alert(`${S.year} 를 정확히 입력해주세요.`);
    if (noAtt && !confirm("마지막 주일 출석 기록이 없습니다. 그래도 전환할까요?")) return;
    $("#nwGo").disabled = true; $("#nwGo").textContent = "적용 중... (창을 닫지 마세요)";
    try { await applyTransition(); closeModal(); alert(`${S.year} 학년도로 전환했습니다.`); location.hash = "#dashboard"; location.reload(); }
    catch (err) { console.error(err); alert("전환 중 오류: " + (err.message || err) + "\n\n일부만 적용됐을 수 있습니다. 새로고침 후 '직전 전환 되돌리기'를 사용하거나 문의해주세요."); closeModal(); }
  };
}

async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach(o => {
      if (o.type === "set") b.set(o.ref, o.data);
      else if (o.type === "update") b.update(o.ref, o.data);
      else b.delete(o.ref);
    });
    await b.commit();
  }
}

async function applyTransition() {
  await Promise.all([loadClasses(true), loadStudents(true), loadTeachers(true)]);
  await saveDraft(true).catch(() => {});
  const d = S.draft, L = S.liveYear, N = S.year, today = todayISO();
  const allClasses = getClassesCache(), allStudents = getStudentsCache(), allTeachers = getTeachersCache();
  const students = rosterStudents();
  const className = (id) => (allClasses.find(c => c.id === id) || {}).name || "";
  const by = currentUser.name || "";

  // 1) 지난 학년도 스냅샷
  const term = {
    year: L, archivedAt: serverTimestamp(), archivedBy: by,
    classes: allClasses.filter(c => !c.archived).map(c => ({ ...c })),
    students: Object.fromEntries(students.map(s => [s.id, { name: s.name || "", classId: s.classId || "", status: s.status || "", plannedClassId: s.plannedClassId || "" }])),
    teachers: Object.fromEntries(activeTeachers().map(t => [t.id, { name: t.name || "", classIds: t.classIds || [] }]))
  };

  // 2) 되돌리기용 이전 값
  const newClassIds = d.classes.map(c => c.id);
  const newTeacherIds = d.newTeachers.map(t => "t" + String(N).slice(2) + "_" + rid());
  const histIds = [];
  const undo = {
    liveYear: L, year: N, createdAt: serverTimestamp(), createdBy: by,
    createdClassIds: newClassIds, createdTeacherIds: newTeacherIds,
    classes: Object.fromEntries(allClasses.map(c => [c.id, { archived: !!c.archived, year: c.year ?? null, order: c.order ?? 0 }])),
    students: Object.fromEntries(students.map(s => [s.id, { classId: s.classId || "", status: s.status || "", plannedClassId: s.plannedClassId || "", lastClassName: s.lastClassName ?? null, graduatedYear: s.graduatedYear ?? null }])),
    teachers: Object.fromEntries(activeTeachers().map(t => [t.id, { classIds: t.classIds || [], retired: !!t.retired, retiredYear: t.retiredYear ?? null, loginEnabled: t.loginEnabled ?? null }])),
    historyIds: histIds
  };

  // 3) 변경 목록
  const ops = [];
  // 교사 이름 (반별)
  const tNamesOf = (cid) => [
    ...activeTeachers().filter(t => d.teachers[t.id]?.active && (d.teachers[t.id].classIds || []).includes(cid)).map(t => t.name),
    ...d.newTeachers.filter(t => (t.classIds || []).includes(cid)).map(t => t.name.trim())
  ];
  allClasses.filter(c => c.id !== "newcomer" && !c.archived).forEach(c => {
    ops.push({ type: "update", ref: doc(db, "classes", c.id), data: { archived: true, year: L } });
  });
  d.classes.forEach((c, i) => {
    ops.push({ type: "set", ref: doc(db, "classes", c.id), data: { name: c.name.trim(), grade: "", order: i + 1, year: N, teacherNames: tNamesOf(c.id), createdAt: serverTimestamp() } });
  });
  ops.push({ type: "update", ref: doc(db, "classes", "newcomer"), data: { order: d.classes.length + 100 } });

  students.forEach(s => {
    const dest = d.assign[s.id];
    if (dest === "newcomer") return; // 그대로
    if (dest === "graduate") {
      ops.push({ type: "update", ref: doc(db, "students", s.id), data: { status: "graduated", classId: "", plannedClassId: "", lastClassName: className(s.classId), graduatedYear: L } });
      const h = doc(collection(db, "rosterHistory")); histIds.push(h.id);
      ops.push({ type: "set", ref: h, data: { studentId: s.id, studentName: s.name || "", classId: s.classId || "", type: "graduated", date: today, note: `${L} 학년도 졸업`, createdBy: by, createdAt: serverTimestamp() } });
      return;
    }
    const upd = { classId: dest, plannedClassId: "" };
    if (s.status === "new") {
      upd.status = "active";
      const h = doc(collection(db, "rosterHistory")); histIds.push(h.id);
      ops.push({ type: "set", ref: h, data: { studentId: s.id, studentName: s.name || "", classId: dest, type: "active", date: today, note: `${N} 학년도 반 배정`, createdBy: by, createdAt: serverTimestamp() } });
    }
    ops.push({ type: "update", ref: doc(db, "students", s.id), data: upd });
  });

  activeTeachers().forEach(t => {
    const v = d.teachers[t.id];
    if (v && v.active) ops.push({ type: "update", ref: doc(db, "teachers", t.id), data: { classIds: v.classIds || [] } });
    else ops.push({ type: "update", ref: doc(db, "teachers", t.id), data: { classIds: [], retired: true, retiredYear: L, loginEnabled: false } });
  });
  const maxOrder = Math.max(0, ...allTeachers.map(t => t.order || 0));
  d.newTeachers.forEach((t, i) => {
    ops.push({ type: "set", ref: doc(db, "teachers", newTeacherIds[i]), data: { name: t.name.trim(), gender: t.gender || "", phone: t.phone.trim(), birthday: "", lunar: false, classIds: t.classIds || [], loginEnabled: true, order: maxOrder + i + 1, note: `${N} 신규`, createdAt: serverTimestamp() } });
  });

  // 4) 기록 순서: 되돌리기 정보 → 스냅샷 → 변경 → 초안 표시 → 설정(마지막)
  await setDoc(doc(db, "termUndo", String(N)), undo);
  await setDoc(doc(db, "terms", String(L)), term);
  await commitOps(ops);
  await setDoc(doc(db, "termDrafts", String(N)), { applied: true, appliedAt: serverTimestamp() }, { merge: true });
  await setDoc(doc(db, "settings", "app"), { liveYear: N, lastTransition: { year: N, from: L, appliedAt: serverTimestamp(), appliedBy: by } }, { merge: true });
  invalidateTerms();
}

// ---------------------------------------------------------------------------
// 되돌리기
// ---------------------------------------------------------------------------
async function undoTransition() {
  const N = S.lastTransition.year;
  let u;
  try { const snap = await getDoc(doc(db, "termUndo", String(N))); u = snap.exists() ? snap.data() : null; } catch (e) { u = null; }
  if (!u) return alert("되돌릴 정보가 없습니다.");
  let hasAtt = false;
  try {
    const r = await getDocs(query(collection(db, "attendance"), where("date", ">=", `${N}-01-01`), limit(1)));
    hasAtt = !r.empty;
  } catch (e) { /* 확인 불가 시 경고만 */ }
  if (!confirm(`${N} 학년도 전환을 되돌려 ${u.liveYear} 학년도로 복원합니다.\n${hasAtt ? `⚠️ ${N}년 출석 기록이 이미 있습니다. 그 기록은 지워지지 않지만 새 반 기준이라 복원된 반과 맞지 않을 수 있습니다.\n` : ""}계속할까요?`)) return;
  try {
    const ops = [];
    (u.createdClassIds || []).forEach(id => ops.push({ type: "delete", ref: doc(db, "classes", id) }));
    for (const tid of u.createdTeacherIds || []) {
      try { await callFn("adminDeleteAccount", { teacherId: tid }); } catch (e) { console.warn(e); }
      ops.push({ type: "delete", ref: doc(db, "teachers", tid) });
    }
    (u.historyIds || []).forEach(id => ops.push({ type: "delete", ref: doc(db, "rosterHistory", id) }));
    Object.entries(u.classes || {}).forEach(([id, v]) => ops.push({ type: "update", ref: doc(db, "classes", id), data: { archived: v.archived, year: v.year, order: v.order } }));
    Object.entries(u.students || {}).forEach(([id, v]) => ops.push({ type: "update", ref: doc(db, "students", id), data: v }));
    Object.entries(u.teachers || {}).forEach(([id, v]) => {
      ops.push({ type: "update", ref: doc(db, "teachers", id), data: { classIds: v.classIds, retired: v.retired, retiredYear: v.retiredYear, loginEnabled: v.loginEnabled } });
    });
    await commitOps(ops);
    await deleteDoc(doc(db, "terms", String(u.liveYear))).catch(() => {});
    await setDoc(doc(db, "termDrafts", String(N)), { applied: false }, { merge: true });
    await setDoc(doc(db, "settings", "app"), { liveYear: u.liveYear, lastTransition: null }, { merge: true });
    await deleteDoc(doc(db, "termUndo", String(N))).catch(() => {});
    invalidateTerms();
    alert(`${u.liveYear} 학년도로 되돌렸습니다.`);
    location.reload();
  } catch (err) { console.error(err); alert("되돌리기 중 오류: " + (err.message || err)); }
}
