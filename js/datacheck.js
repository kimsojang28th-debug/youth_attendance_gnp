// ============================================================
// 데이터 점검 (관리자): 전화번호 형식 정리 + 같은 이름·연락처 중복 찾기
// ------------------------------------------------------------
// - 번호 정리는 미리보기를 보여준 뒤 [적용]을 눌러야 저장된다. 적용 전에 백업 내려받기를 권장한다.
// - 중복은 찾아서 목록만 보여주고, 정리(삭제/병합)는 관리자가 확인한 뒤 직접 한다.
// ============================================================
import { db, doc, writeBatch } from "./firebase-init.js";
import { $, escapeHtml, openModal, closeModal, formatPhone, phoneDigits, STUDENT_STATUS_LABEL } from "./utils.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { loadTeachers, getTeachersCache } from "./teachers.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { downloadBackup } from "./backup.js";

const validPhone = (d) => d.length >= 9 && d.length <= 11 && d.startsWith("0");
const nameKey = (v) => String(v || "").replace(/\s+/g, "");

function analyze() {
  const classMap = Object.fromEntries(getClassesCache().map(c => [c.id, c.name]));
  const changes = []; // { col, id, who, patch, shown: [[before, after]] }
  const invalid = []; // 확인이 필요한 번호
  const check = (raw, who, label) => {
    const v = String(raw || "").trim();
    if (!v || v.startsWith("+")) return null;
    const d = phoneDigits(v);
    if (!validPhone(d)) { invalid.push(`${who} · ${label}: ${v}`); return null; }
    const f = formatPhone(v);
    return f !== v ? f : null;
  };
  getStudentsCache().forEach(s => {
    const patch = {}, shown = [];
    const f = check(s.phone, s.name, "학생 번호");
    if (f) { patch.phone = f; shown.push([s.phone, f]); }
    if (Array.isArray(s.guardians) && s.guardians.length) {
      let any = false;
      const gs = s.guardians.map(g => {
        const gf = check(g.phone, s.name, `보호자(${g.relation || ""}) 번호`);
        if (gf) { any = true; shown.push([g.phone, gf]); return { ...g, phone: gf }; }
        return g;
      });
      if (any) patch.guardians = gs;
    }
    if (Object.keys(patch).length) changes.push({ col: "students", id: s.id, who: `${s.name} (학생)`, patch, shown });
  });
  getTeachersCache().forEach(t => {
    const f = check(t.phone, t.name, "교사 번호");
    if (f) changes.push({ col: "teachers", id: t.id, who: `${t.name} (교사)`, patch: { phone: f }, shown: [[t.phone, f]] });
  });

  const groups = (list, kind) => {
    const map = new Map();
    list.forEach(o => {
      const d = phoneDigits(o.phone);
      if (d.length < 9) return;
      const k = `${nameKey(o.name)}|${d}`;
      (map.get(k) || map.set(k, []).get(k)).push(o);
    });
    return [...map.values()].filter(g => g.length > 1).map(g => ({ kind, items: g }));
  };
  const dups = [
    ...groups(getStudentsCache(), "학생"),
    ...groups(getTeachersCache(), "교사")
  ];
  const describe = (o, kind) => kind === "교사"
    ? `${o.retired ? "퇴임" : "교사"}`
    : `${o.classId === "newcomer" ? "새친구" : (classMap[o.classId] || "반 없음")} · ${STUDENT_STATUS_LABEL[o.status] || o.status}`;
  return { changes, invalid, dups, describe };
}

export async function openDataCheckModal() {
  await Promise.all([loadClasses(), loadStudents(true), loadTeachers(true)]);
  const r = analyze();
  const cap = (arr, n = 60) => arr.slice(0, n);
  openModal(`
    <h3>번호 정리 · 중복 점검</h3>

    <div class="dc-sec">
      <b>1. 전화번호 형식 정리</b> — 바꿀 번호 ${r.changes.length}명 분
      ${r.changes.length ? `<div class="dc-list">${cap(r.changes).map(c => `<div>${escapeHtml(c.who)}: ${c.shown.map(([a, b]) => `${escapeHtml(a)} → <b>${escapeHtml(b)}</b>`).join(", ")}</div>`).join("")}${r.changes.length > 60 ? `<div class="dim-note">외 ${r.changes.length - 60}명</div>` : ""}</div>` : `<p class="dim-note">정리할 번호가 없습니다. 모두 형식이 맞습니다.</p>`}
      ${r.invalid.length ? `<p style="margin-top:8px;color:#9a6700;">⚠️ 번호 자리수가 맞지 않아 그대로 둔 항목 ${r.invalid.length}건 — 직접 확인해 주세요.</p><div class="dc-list">${cap(r.invalid).map(x => `<div>${escapeHtml(x)}</div>`).join("")}</div>` : ""}
    </div>

    <div class="dc-sec">
      <b>2. 같은 이름 + 같은 연락처 중복</b> — ${r.dups.length}건
      ${r.dups.length ? `<div class="dc-list">${r.dups.map(g => `<div><b>${escapeHtml(g.items[0].name)}</b> (${g.kind}) ${escapeHtml(formatPhone(g.items[0].phone))}<br/>${g.items.map(o => `└ ${escapeHtml(r.describe(o, g.kind))}`).join("<br/>")}</div>`).join("")}</div><p class="dim-note">같은 사람이 새친구와 반에 이중 등록된 경우가 많습니다. 확인하신 뒤 한 쪽을 삭제해 주세요.</p>` : `<p class="dim-note">중복이 없습니다.</p>`}
    </div>

    <div class="modal-actions">
      <button id="dcBackup" class="btn">💾 백업 내려받기</button>
      <button id="dcClose" class="btn">닫기</button>
      <button id="dcApply" class="btn btn-primary" ${r.changes.length ? "" : "disabled"}>번호 형식 정리 적용 (${r.changes.length}명)</button>
    </div>
    <p id="dcMsg" class="dim-note"></p>
  `, { wide: true });
  $("#dcClose").onclick = closeModal;
  $("#dcBackup").onclick = async (e) => {
    e.target.disabled = true;
    try { await downloadBackup({}); $("#dcMsg").textContent = "백업 파일을 내려받았습니다."; }
    catch (err) { $("#dcMsg").textContent = "백업 실패: " + (err.message || err); }
    e.target.disabled = false;
  };
  $("#dcApply").onclick = async (e) => {
    if (!confirm(`${r.changes.length}명의 전화번호 형식을 바꿉니다.\n(백업을 먼저 받아 두는 것을 권장합니다) 계속할까요?`)) return;
    e.target.disabled = true;
    try {
      for (let i = 0; i < r.changes.length; i += 400) {
        const b = writeBatch(db);
        r.changes.slice(i, i + 400).forEach(c => b.update(doc(db, c.col, c.id), c.patch));
        await b.commit();
      }
      await Promise.all([loadStudents(true), loadTeachers(true)]);
      $("#dcMsg").textContent = `${r.changes.length}명의 번호 형식을 정리했습니다.`;
      setTimeout(openDataCheckModal, 800);
    } catch (err) {
      $("#dcMsg").textContent = "저장 중 오류: " + (err.message || err);
      e.target.disabled = false;
    }
  };
}
