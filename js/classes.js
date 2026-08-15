import { db, collection, getDocs, query, orderBy, setDoc, doc } from "./firebase-init.js";

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
