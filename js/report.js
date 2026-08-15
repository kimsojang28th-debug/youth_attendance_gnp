import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { getAttendanceDoc } from "./attendance.js";
import { $, escapeHtml, nearestSundayISO, toast } from "./utils.js";
import { currentUser } from "./auth.js";

export async function initReportView() {
  await loadClasses();
  await loadStudents();
  const dateInput = $("#reportDate");
  if (!dateInput.value) dateInput.value = nearestSundayISO();
  $("#loadReportBtn").onclick = renderReport;
  await renderReport();
}

async function getWeeklyMeta(date) {
  const snap = await getDoc(doc(db, "weeklyMeta", date));
  return snap.exists() ? snap.data() : {};
}

export async function buildAttendanceSummary(date) {
  const classes = getClassesCache();
  const students = getStudentsCache();
  const rows = [];
  let totalRoster = 0, totalPresent = 0;

  for (const c of classes) {
    const classStudents = students.filter(s => s.classId === c.id && (s.status === "active" || s.status === "new"));
    const attDoc = await getAttendanceDoc(c.id, date);
    const records = attDoc?.records || {};
    const present = classStudents.filter(s => records[s.id] === "O").length;
    const roster = classStudents.length;
    totalRoster += roster;
    totalPresent += present;
    rows.push({ className: c.name, roster, present });
  }
  return { rows, totalRoster, totalPresent };
}

async function renderReport() {
  const date = $("#reportDate").value;
  if (!date) return;
  const meta = await getWeeklyMeta(date);
  const { rows, totalRoster, totalPresent } = await buildAttendanceSummary(date);
  const offering = meta.offering || {};
  const offeringTotal = ["weekly", "tithe", "thanks", "other"]
    .reduce((sum, k) => sum + (Number(offering[k]) || 0), 0);

  $("#reportBody").innerHTML = `
    <div class="panel">
      <h3>설교 및 예배 정보</h3>
      <label>설교 본문</label>
      <input id="m_sermonText" value="${escapeHtml(meta.sermonText || "")}" />
      <label>설교 제목</label>
      <input id="m_sermonTitle" value="${escapeHtml(meta.sermonTitle || "")}" />
      <label>설교자</label>
      <input id="m_preacher" value="${escapeHtml(meta.preacher || "")}" />
    </div>

    <div class="panel">
      <h3>헌금 내역</h3>
      <div class="card-grid">
        <div><label>주일헌금</label><input type="number" id="m_off_weekly" value="${offering.weekly || 0}" /></div>
        <div><label>십일조</label><input type="number" id="m_off_tithe" value="${offering.tithe || 0}" /></div>
        <div><label>감사헌금</label><input type="number" id="m_off_thanks" value="${offering.thanks || 0}" /></div>
        <div><label>기타(절기 등)</label><input type="number" id="m_off_other" value="${offering.other || 0}" /></div>
      </div>
      <p style="margin-top:10px;font-weight:700;">합계: ₩${offeringTotal.toLocaleString()}</p>
    </div>

    <div class="panel">
      <h3>주간심방 및 기도제목 / 건의사항</h3>
      <textarea id="m_visitationNotes" rows="3">${escapeHtml(meta.visitationNotes || "")}</textarea>
    </div>

    <div class="panel">
      <h3>실시 및 예정 사항</h3>
      <textarea id="m_scheduleNotes" rows="3">${escapeHtml(meta.scheduleNotes || "")}</textarea>
    </div>

    <button id="saveMetaBtn" class="btn btn-primary">주간보고서 저장</button>
    <p id="reportSaveMsg" class="save-msg"></p>

    <div class="panel" style="margin-top:20px;">
      <h3>학생 출결 사항 (자동 집계)</h3>
      <div class="table-scroll">
      <table>
        <thead><tr><th>반</th><th>재적</th><th>출석</th><th>출석률</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escapeHtml(r.className)}</td>
              <td>${r.roster}</td>
              <td>${r.present}</td>
              <td>${r.roster ? Math.round((r.present / r.roster) * 1000) / 10 : 0}%</td>
            </tr>
          `).join("")}
          <tr style="font-weight:700;">
            <td>합계</td><td>${totalRoster}</td><td>${totalPresent}</td>
            <td>${totalRoster ? Math.round((totalPresent / totalRoster) * 1000) / 10 : 0}%</td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  `;

  $("#saveMetaBtn").onclick = async () => {
    await setDoc(doc(db, "weeklyMeta", date), {
      date,
      sermonText: $("#m_sermonText").value,
      sermonTitle: $("#m_sermonTitle").value,
      preacher: $("#m_preacher").value,
      offering: {
        weekly: Number($("#m_off_weekly").value) || 0,
        tithe: Number($("#m_off_tithe").value) || 0,
        thanks: Number($("#m_off_thanks").value) || 0,
        other: Number($("#m_off_other").value) || 0
      },
      visitationNotes: $("#m_visitationNotes").value,
      scheduleNotes: $("#m_scheduleNotes").value,
      updatedBy: currentUser.uid,
      updatedAt: serverTimestamp()
    });
    toast("주간보고서가 저장되었습니다.", $("#reportSaveMsg"));
  };
}
