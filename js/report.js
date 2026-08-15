import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { getAttendanceDoc } from "./attendance.js";
import { $, escapeHtml, nearestSundayISO, sortByName, sundaySelectOptionsHtml, toast } from "./utils.js";
import { currentUser } from "./auth.js";

export async function initReportView() {
  await loadClasses();
  await loadStudents();
  const dateSelect = $("#reportDate");
  dateSelect.innerHTML = sundaySelectOptionsHtml(dateSelect.value || nearestSundayISO());
  $("#loadReportBtn").onclick = renderReport;
  await renderReport();
}

async function getWeeklyMeta(date) {
  const snap = await getDoc(doc(db, "weeklyMeta", date));
  return snap.exists() ? snap.data() : {};
}

// 반별 학생 명단(가나다순) + 그 주 출결(O/X)을 함께 담아 반환
export async function buildAttendanceDetail(date) {
  const classes = getClassesCache();
  const students = getStudentsCache();
  const details = [];
  let totalRoster = 0, totalPresent = 0;
  let totalRegularRoster = 0, totalRegularPresent = 0, totalNewRoster = 0, totalNewPresent = 0;

  for (const c of classes) {
    const classStudents = sortByName(
      students.filter(s => s.classId === c.id && (s.status === "active" || s.status === "new"))
    );
    const attDoc = await getAttendanceDoc(c.id, date);
    const records = attDoc?.records || {};
    const studentRows = classStudents.map(s => ({
      id: s.id,
      name: s.name,
      isNew: s.status === "new",
      val: records[s.id] === "O" ? "O" : "X"
    }));
    const present = studentRows.filter(s => s.val === "O").length;
    const roster = studentRows.length;

    // 새친구는 반 소속이지만 상태가 다르므로, 정회원/새친구를 나눈 소계도 함께 계산
    // (전체 재적/출석 합계는 그대로 유지하고, 새친구 소계는 참고용으로 별도 제공)
    const regularRows = studentRows.filter(s => !s.isNew);
    const newRows = studentRows.filter(s => s.isNew);
    const regularRoster = regularRows.length;
    const regularPresent = regularRows.filter(s => s.val === "O").length;
    const newRoster = newRows.length;
    const newPresent = newRows.filter(s => s.val === "O").length;

    totalRoster += roster;
    totalPresent += present;
    totalRegularRoster += regularRoster;
    totalRegularPresent += regularPresent;
    totalNewRoster += newRoster;
    totalNewPresent += newPresent;

    details.push({
      classId: c.id, className: c.name, roster, present,
      regularRoster, regularPresent, newRoster, newPresent,
      students: studentRows
    });
  }
  return {
    details, totalRoster, totalPresent,
    totalRegularRoster, totalRegularPresent, totalNewRoster, totalNewPresent
  };
}

async function renderReport() {
  const date = $("#reportDate").value;
  if (!date) return;
  const meta = await getWeeklyMeta(date);
  const {
    details, totalRoster, totalPresent,
    totalRegularRoster, totalRegularPresent, totalNewRoster, totalNewPresent
  } = await buildAttendanceDetail(date);
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
      <h3>학생 출결 사항</h3>
      <div class="report-grid">
        ${details.map(d => `
          <div class="report-class-card">
            <div class="report-class-card-header">
              <span>${escapeHtml(d.className)}</span>
            </div>
            <div class="report-class-subtotals">
              <div class="report-subtotal-line">정회원 재적 ${d.regularRoster}명 · 출석 ${d.regularPresent}명</div>
              <div class="report-subtotal-line report-subtotal-new">새친구 재적 ${d.newRoster}명 · 출석 ${d.newPresent}명</div>
            </div>
            <div class="report-class-card-body">
              ${d.students.length ? d.students.map(s => `
                <div class="report-student-row">
                  <span>${escapeHtml(s.name)}${s.isNew ? ' <span class="badge badge-new" style="padding:1px 6px;font-size:10px;">새</span>' : ""}</span>
                  <span class="badge badge-${s.val === "O" ? "o" : "x"}">${s.val}</span>
                </div>
              `).join("") : `<p class="list empty" style="padding:4px 0;font-size:12.5px;">학생 없음</p>`}
            </div>
          </div>
        `).join("")}
      </div>
      <p style="margin-top:16px;font-weight:700;">
        전체 합계: 재적 ${totalRoster}명 / 출석 ${totalPresent}명 / 결석 ${totalRoster - totalPresent}명
        (${totalRoster ? Math.round((totalPresent / totalRoster) * 1000) / 10 : 0}%)
      </p>
      <p style="margin-top:4px;font-size:12.5px;color:#6b7280;">
        정회원 재적 ${totalRegularRoster}명 · 출석 ${totalRegularPresent}명 &nbsp;/&nbsp;
        새친구 재적 ${totalNewRoster}명 · 출석 ${totalNewPresent}명
      </p>
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
