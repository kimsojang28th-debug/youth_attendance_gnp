// ============================================================
// 학년도(해마다 독립된 명부) 관리
// ------------------------------------------------------------
// - 사람 정보(이름/연락처/사진 등)는 students / teachers 에 계속 이어지고,
//   "그해의 반 구성 · 학생 반 배정 · 교사와 담당반"은 학년도마다 따로 보관한다.
// - 현재(라이브) 학년도는 지금 쓰는 데이터(classes/students/teachers)가 곧 명부다.
// - 새 학년도로 전환하면 지난 학년도의 명부가 terms/{연도} 에 그대로 고정 보관되고,
//   연간출석부·주간보고서·출석체크·재적부·교사현황에서 연도를 고르면 그해 명부로 보인다.
// ============================================================
import { db, doc, getDoc, getDocs, collection } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { loadTeachers, getTeachersCache } from "./teachers.js";

// settings/app 문서가 아직 없을 때(전환 전)의 현재 학년도
export const DEFAULT_LIVE_YEAR = 2026;

let _settings = null;
const _termCache = new Map();
let _archivedYears = null;

export async function loadSettings(force = false) {
  if (_settings && !force) return _settings;
  try {
    const snap = await getDoc(doc(db, "settings", "app"));
    _settings = snap.exists() ? snap.data() : {};
  } catch (err) {
    console.warn("설정 조회 실패", err);
    _settings = {};
  }
  return _settings;
}

export async function getLiveYear() {
  const s = await loadSettings();
  return Number(s.liveYear) || DEFAULT_LIVE_YEAR;
}

// 지난 학년도 날짜인지 (지난 학년도 출석/예배정보는 관리자만 수정)
export async function isPastDate(date) {
  const y = Number(String(date || "").slice(0, 4));
  return !!y && y < await getLiveYear();
}

// 반의 담당 교사 이름: 교사현황의 담당반(classIds)이 기준. 아직 담당반이 입력되지 않은 옛 데이터는 반에 직접 적어둔 이름으로 대신한다.
export function teacherNamesOfClass(roster, cls) {
  const list = (roster.teachers || [])
    .filter(t => (roster.live ? !t.retired : true) && (t.classIds || []).includes(cls.id))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  const names = list.map(t => t.name).filter(Boolean);
  return names.length ? names : (cls.teacherNames || []);
}

export function invalidateTerms() {
  _settings = null;
  _archivedYears = null;
  _termCache.clear();
}

// 보관된(지난) 학년도 명부 한 해치
export async function loadTerm(year, force = false) {
  const key = String(year);
  if (_termCache.has(key) && !force) return _termCache.get(key);
  let data = null;
  try {
    const snap = await getDoc(doc(db, "terms", key));
    data = snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn("학년도 명부 조회 실패", err);
  }
  _termCache.set(key, data);
  return data;
}

// 보관된 학년도 목록(최신순)
export async function listArchivedYears(force = false) {
  if (_archivedYears && !force) return _archivedYears;
  try {
    const snap = await getDocs(collection(db, "terms"));
    _archivedYears = snap.docs.map(d => Number(d.id)).filter(Boolean).sort((a, b) => b - a);
  } catch (err) {
    console.warn("학년도 목록 조회 실패", err);
    _archivedYears = [];
  }
  return _archivedYears;
}

// 특정 학년도의 반/학생/교사 명부.
//  - 현재 학년도(이상): 지금 데이터
//  - 지난 학년도: 보관된 명부(없으면 지금 데이터로 대체, missing: true)
// 학생은 보관된 반 배정·상태에 사진/연락처 같은 현재 정보를 합쳐서 돌려준다.
export async function rosterForYear(year) {
  await Promise.all([loadClasses(), loadStudents(), loadTeachers()]);
  const liveYear = await getLiveYear();
  const live = () => ({
    year, live: true, missing: false,
    classes: getClassesCache(), students: getStudentsCache(), teachers: getTeachersCache()
  });
  if (!year || year >= liveYear) return live();
  const term = await loadTerm(year);
  if (!term) return { ...live(), live: false, missing: true };

  const liveStudents = new Map(getStudentsCache().map(s => [s.id, s]));
  const liveTeachers = new Map(getTeachersCache().map(t => [t.id, t]));
  const classes = [...(term.classes || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  const students = Object.entries(term.students || {}).map(([id, v]) => ({ ...(liveStudents.get(id) || {}), ...v, id }));
  const teachers = Object.entries(term.teachers || {}).map(([id, v]) => ({ ...(liveTeachers.get(id) || {}), ...v, id }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  return { year, live: false, missing: false, classes, students, teachers };
}

// "2027 학년도 전환" 안내(관리자 대시보드): 12월 20일 이후이거나, 새해가 되었는데 아직 전환하지 않은 경우
export async function getTransitionNotice(today = new Date()) {
  const liveYear = await getLiveYear();
  const y = today.getFullYear();
  const late = (y === liveYear && today.getMonth() === 11 && today.getDate() >= 20) || y > liveYear;
  if (!late) return null;
  const nextYear = liveYear + 1;
  let draft = null;
  try {
    const snap = await getDoc(doc(db, "termDrafts", String(nextYear)));
    draft = snap.exists() ? snap.data() : null;
  } catch (err) { /* 규칙/권한 문제면 안내만 생략 */ }
  return { nextYear, hasDraft: !!draft, started: y > liveYear };
}
