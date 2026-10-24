// 전체 데이터 백업: 앱의 모든 컬렉션을 JSON 파일 하나로 내려받는다(관리자 전용).
// 새 학년도 전환 같은 큰 작업 전에 받아두면, 문제가 생겨도 원래 상태를 확인/복구할 수 있다.
import { db, collection, getDocs } from "./firebase-init.js";
import { todayISO } from "./utils.js";

const COLLECTIONS = [
  "classes", "students", "teachers", "attendance", "weeklyMeta",
  "rosterHistory", "yearlyPlan", "events", "terms", "termDrafts", "termUndo", "settings"
];

export async function downloadBackup({ includePhotos = true } = {}) {
  const out = { app: "youth-attendance-gnp", exportedAt: new Date().toISOString(), collections: {} };
  const counts = {};
  const failed = [];
  for (const name of COLLECTIONS) {
    try {
      const snap = await getDocs(collection(db, name));
      out.collections[name] = snap.docs.map(d => {
        const data = { ...d.data() };
        if (!includePhotos && data.photoDataUrl) data.photoDataUrl = "";
        return { id: d.id, data };
      });
      counts[name] = snap.docs.length;
    } catch (err) {
      console.warn("백업 조회 실패:", name, err);
      failed.push(name);
    }
  }
  const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `청소년부재적관리_백업_${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return { counts, failed, bytes: blob.size };
}
