import { db, doc, getDoc } from "./firebase-init.js";
import { loadClasses, getClassesCache, getClassById } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { getAttendanceDoc } from "./attendance.js";
import {
  $, escapeHtml, nearestSundayISO, sortByName,
  yearSelectOptionsHtml, sundayOptionsHtmlForYear, getSundaysOfYear,
  openModal, closeModal
} from "./utils.js";

// "주간보고서" 화면: 예배정보입력(js/worship.js)에서 입력한 내용 + 출석체크 결과를
// 모아서 보여주기만 하는 읽기 전용 화면. (입력은 예배정보입력 화면에서, 반별 출석 결과는
// 출석체크 화면에서 각각 입력하고, 여기서는 결과만 확인)

export async function initReportView() {
  await loadClasses();
  await loadStudents();
  const dateSelect = $("#reportDate");
  const thisYear = new Date().getFullYear();
  const yearSelect = $("#reportYearSelect");
  yearSelect.innerHTML = yearSelectOptionsHtml(thisYear);
  dateSelect.innerHTML = sundayOptionsHtmlForYear(thisYear, nearestSundayISO());

  yearSelect.onchange = () => {
    const year = Number(yearSelect.value);
    const defaultDate = year === new Date().getFullYear() ? nearestSundayISO() : getSundaysOfYear(year)[0];
    dateSelect.innerHTML = sundayOptionsHtmlForYear(year, defaultDate);
  };

  $("#loadReportBtn").onclick = renderReport;
  await renderReport();
}

async function getWeeklyMeta(date) {
  const snap = await getDoc(doc(db, "weeklyMeta", date));
  return snap.exists() ? snap.data() : {};
}

// 반별 학생 명단(가나다순) + 그 주 출결(O/X) + 출결사유/특이사항을 함께 담아 반환
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
    const notes = attDoc?.notes || {};
    const studentRows = classStudents.map(s => ({
      id: s.id,
      name: s.name,
      isNew: s.status === "new",
      val: records[s.id] === "O" ? "O" : "X",
      note: notes[s.id] || ""
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
      <div class="report-info-grid">
        <div class="report-info-card">
          <span class="report-info-icon">📖</span>
          <div><span class="report-readonly-label">설교 본문</span><span class="report-readonly-value">${escapeHtml(meta.sermonText || "-")}</span></div>
        </div>
        <div class="report-info-card">
          <span class="report-info-icon">📝</span>
          <div><span class="report-readonly-label">설교 제목</span><span class="report-readonly-value">${escapeHtml(meta.sermonTitle || "-")}</span></div>
        </div>
        <div class="report-info-card">
          <span class="report-info-icon">🎤</span>
          <div><span class="report-readonly-label">설교자</span><span class="report-readonly-value">${escapeHtml(meta.preacher || "-")}</span></div>
        </div>
      </div>
    </div>

    <div class="panel">
      <h3>헌금 내역</h3>
      <div class="report-offering-grid">
        <div class="report-offering-item">
          <span class="report-offering-icon">🙏</span>
          <span class="report-offering-label">주일헌금</span>
          <span class="report-offering-value">₩${(offering.weekly || 0).toLocaleString()}</span>
        </div>
        <div class="report-offering-item">
          <span class="report-offering-icon">💛</span>
          <span class="report-offering-label">십일조</span>
          <span class="report-offering-value">₩${(offering.tithe || 0).toLocaleString()}</span>
        </div>
        <div class="report-offering-item">
          <span class="report-offering-icon">✨</span>
          <span class="report-offering-label">감사헌금</span>
          <span class="report-offering-value">₩${(offering.thanks || 0).toLocaleString()}</span>
        </div>
        <div class="report-offering-item">
          <span class="report-offering-icon">🎉</span>
          <span class="report-offering-label">기타(절기 등)</span>
          <span class="report-offering-value">₩${(offering.other || 0).toLocaleString()}</span>
        </div>
      </div>
      <div class="report-offering-total">헌금 합계 <strong>₩${offeringTotal.toLocaleString()}</strong></div>
    </div>

    <div class="panel">
      <h3>주간심방 및 기도제목 / 건의사항</h3>
      <p class="report-readonly-block">${escapeHtml(meta.visitationNotes || "") || `<span class="dim-note">입력된 내용이 없습니다.</span>`}</p>
    </div>

    <div class="panel">
      <h3>실시 및 예정 사항</h3>
      <p class="report-readonly-block">${escapeHtml(meta.scheduleNotes || "") || `<span class="dim-note">입력된 내용이 없습니다.</span>`}</p>
    </div>

    <div class="panel" style="margin-top:20px;">
      <h3>학생 출결 사항</h3>
      <div class="report-summary-box">
        <p class="report-summary-total">
          전체 합계: 재적 ${totalRoster}명 / 출석 ${totalPresent}명 / 결석 ${totalRoster - totalPresent}명
          (${totalRoster ? Math.round((totalPresent / totalRoster) * 1000) / 10 : 0}%)
        </p>
        <p class="report-summary-sub">
          정회원 재적 ${totalRegularRoster}명 · 출석 ${totalRegularPresent}명 &nbsp;/&nbsp;
          새친구 재적 ${totalNewRoster}명 · 출석 ${totalNewPresent}명
        </p>
      </div>
      <div class="report-grid">
        ${details.map(d => {
          const cls = getClassById(d.classId);
          const teacherNames = (cls?.teacherNames || []).filter(Boolean);
          return `
          <div class="report-class-card">
            <div class="report-class-card-header">
              <span>${escapeHtml(d.className)}</span>
            </div>
            <div class="report-class-teacher-line">
              ${teacherNames.length ? `담당: ${escapeHtml(teacherNames.join(", "))}` : `담당 선생님 미배정`}
            </div>
            <div class="report-class-tally-line">
              재적 ${d.roster}명 · 출석 ${d.present}명 · 결석 ${d.roster - d.present}명
            </div>
            <div class="report-class-card-body">
              ${d.students.length ? d.students.map(s => {
                const hasNote = !!(s.note && s.note.trim());
                return `
                <div class="report-student-row">
                  <span>${escapeHtml(s.name)}${s.isNew ? ' <span class="badge badge-new" style="padding:1px 6px;font-size:10px;">새</span>' : ""}</span>
                  <span class="badge badge-${s.val === "O" ? "o" : "x"} ${hasNote ? "badge-has-note" : ""}"
                    ${hasNote ? `data-name="${escapeHtml(s.name)}" data-note="${escapeHtml(s.note)}"` : ""}
                  >${s.val}</span>
                </div>
              `;
              }).join("") : `<p class="list empty" style="padding:4px 0;font-size:12.5px;">학생 없음</p>`}
            </div>
          </div>
        `;
        }).join("")}
      </div>
    </div>
  `;

  $("#reportBody").querySelectorAll(".badge-has-note").forEach(badge => {
    badge.onclick = () => {
      openModal(`
        <h3>출결 특이사항</h3>
        <p style="font-size:13px;color:#6b7280;margin:0 0 10px;">${escapeHtml(badge.dataset.name)} · ${escapeHtml(date)}</p>
        <p style="white-space:pre-wrap;line-height:1.6;">${escapeHtml(badge.dataset.note)}</p>
        <div class="modal-actions">
          <button id="cancelBtn" class="btn">닫기</button>
        </div>
      `);
      $("#cancelBtn").onclick = closeModal;
    };
  });
}
