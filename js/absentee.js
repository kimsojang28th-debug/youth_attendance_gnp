import { db, collection, getDocs, query, where } from "./firebase-init.js";
import { getClassesCache } from "./classes.js";
import { getStudentsCache } from "./students.js";
import { nearestSundayISO } from "./utils.js";

const LOOKBACK_WEEKS = 15; // 최대 이만큼 과거까지 조회해서 연속결석 주수를 계산
const ALERT_THRESHOLD = 3; // 이 주수 이상 연속 결석하면 대시보드에 경고 표시

// classId 하나에 대해 최근 LOOKBACK_WEEKS 개의 출석 기록을 최신순으로 가져옴.
// (예전엔 orderBy+limit을 Firestore 쿼리에 그대로 걸었는데, 이 조합은 연간출석부(classId==+date범위)와는
// 다른 별도의 복합 색인이 필요해서, 그 색인이 없으면 조용히 실패해 장기결석 학생이 0명으로 보이는 버그가 있었음.
// 연간출석부와 동일하게 "classId== + date<=" 만 서버에 걸고, 최신순 정렬/개수 제한은 결과를 받은 뒤
// 자바스크립트에서 처리하도록 바꿔서 별도 색인이 필요 없게 함.)
async function fetchRecentAttendance(classId, beforeOrEqualDate) {
  const q = query(
    collection(db, "attendance"),
    where("classId", "==", classId),
    where("date", "<=", beforeOrEqualDate)
  );
  const snap = await getDocs(q);
  return snap.docs
    .map(d => d.data())
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)) // 최신 날짜부터
    .slice(0, LOOKBACK_WEEKS);
}

// 연속 결석 주수 계산: 가장 최근 기록부터 역순으로 훑으며 X(또는 미기록)가 이어지는 구간 카운트
function countConsecutiveAbsence(studentId, attendanceDocsDesc) {
  let count = 0;
  for (const docData of attendanceDocsDesc) {
    const val = docData.records?.[studentId];
    if (val === "O") break;
    count++; // "X" 이거나 기록이 아예 없는 경우 모두 결석으로 간주
  }
  return count;
}

export async function computeLongTermAbsentees(visibleClassIds = null) {
  const classes = getClassesCache().filter(c => !visibleClassIds || visibleClassIds.includes(c.id));
  const students = getStudentsCache().filter(s => s.status === "active" || s.status === "new");
  const asOf = nearestSundayISO();
  const results = [];
  let indexError = null; // 반 하나라도 조회 실패하면 원인(대개 Firestore 색인 문제)을 화면에 보여주기 위해 보관

  for (const c of classes) {
    let attDocs;
    try {
      attDocs = await fetchRecentAttendance(c.id, asOf);
    } catch (err) {
      console.warn("출석 조회 실패 (Firestore 색인이 필요할 수 있습니다):", err);
      if (!indexError) indexError = err;
      continue;
    }
    if (!attDocs.length) continue;

    const classStudents = students.filter(s => s.classId === c.id);
    for (const s of classStudents) {
      const weeks = countConsecutiveAbsence(s.id, attDocs);
      if (weeks >= ALERT_THRESHOLD) {
        results.push({ studentId: s.id, name: s.name, classId: c.id, className: c.name, weeks });
      }
    }
  }

  // 연속 결석 주수가 적은 학생부터(작은 순 -> 많은 순) 보여주도록 정렬 (2026-08-16, 사용자 요청으로 정렬 반대로 변경)
  results.sort((a, b) => a.weeks - b.weeks);
  return { results, indexError };
}

export { ALERT_THRESHOLD };
