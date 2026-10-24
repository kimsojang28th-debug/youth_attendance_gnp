import { db, doc, getDoc } from "./firebase-init.js";
import { loadClasses, getClassesCache, getClassById } from "./classes.js";
import { loadStudents, getStudentsCache, openStudentProfileModal, studentThumbHtml } from "./students.js";
import { getAttendanceDoc } from "./attendance.js";
import { rosterForYear, teacherNamesOfClass } from "./terms.js";
import { currentUser } from "./auth.js";
import {
  $, escapeHtml, nearestSundayISO, sortByName, fmtMonthDay,
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
  $("#printReportBtn").onclick = () => window.print();
  await renderReport();
}

async function getWeeklyMeta(date) {
  const snap = await getDoc(doc(db, "weeklyMeta", date));
  return snap.exists() ? snap.data() : {};
}

// 반별 학생 명단(가나다순) + 그 주 출결(O/X) + 출결사유/특이사항을 함께 담아 반환
export async function buildAttendanceDetail(date) {
  // 날짜가 속한 학년도의 반/학생 명부로 계산(지난 해 보고서는 그해 편성 그대로 보임)
  const _roster = await rosterForYear(Number(String(date).slice(0, 4)));
  const { classes, students } = _roster;
  const details = [];
  let totalRoster = 0, totalPresent = 0;
  let totalRegularRoster = 0, totalRegularPresent = 0, totalNewRoster = 0, totalNewPresent = 0;

  for (const c of classes) {
    // 2026-08-23(4차): 이 날짜 시점에 아직 등록(joinDate) 전이었던 학생은 그 주 보고서의
    // 반별 명단/재적·출석 집계에서 제외함 — 안 그러면 나중에 합류한 학생이 합류 전 주차의
    // 보고서에도 "재적"으로 잡히고 결석 처리되어 보이는 문제가 있었음(등록일이 서로 다른
    // 학생이 섞이기 쉬운 새친구반에서 특히 두드러짐). joinDate가 비어있는 학생은 예전처럼
    // 항상 포함함.
    const classStudents = sortByName(
      students.filter(s =>
        s.classId === c.id && (s.status === "active" || s.status === "new") &&
        (!s.joinDate || s.joinDate <= date)
      )
    );
    const attDoc = await getAttendanceDoc(c.id, date);
    const records = attDoc?.records || {};
    const notes = attDoc?.notes || {};
    const studentRows = classStudents.map(s => ({
      id: s.id,
      name: s.name,
      isNew: s.status === "new",
      // 새친구반 학생은 실제 학년(예정 반)을 등록해뒀다면 함께 표시해서, 새친구반만 봐서는
      // 알 수 없는 "이 아이는 원래 몇 학년인지"를 보고서에서도 바로 확인할 수 있게 함.
      plannedClassName: (s.status === "new" && s.plannedClassId)
        ? (classes.find(c => c.id === s.plannedClassId)?.name || "")
        : "",
      val: records[s.id] === "O" ? "O" : "X",
      note: notes[s.id] || "",
      photoDataUrl: s.photoDataUrl || ""
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
      classId: c.id, className: c.name, teacherNames: teacherNamesOfClass(_roster, c), roster, present,
      checked: !!attDoc, // 이 주일의 출석체크가 저장된 적이 있는지(대시보드 "이번 주 할 일" 상태 표시용)
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
          재적 합계: 재적 ${totalRegularRoster}명 / 출석 ${totalRegularPresent}명 / 결석 ${totalRegularRoster - totalRegularPresent}명
          (${totalRegularRoster ? Math.round((totalRegularPresent / totalRegularRoster) * 1000) / 10 : 0}%)
        </p>
        <p class="report-summary-sub">
          새친구반 별도: 재적 ${totalNewRoster}명 · 출석 ${totalNewPresent}명 (위 재적 합계에는 포함되지 않음)
        </p>
      </div>
      <div class="report-grid">
        ${details.map(d => {
          const teacherNames = (d.teacherNames || getClassById(d.classId)?.teacherNames || []).filter(Boolean);
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
                  <span class="student-name-cell">${studentThumbHtml(s)}<a href="#" class="student-name-link" data-student-id="${s.id}">${escapeHtml(s.name)}</a>${s.isNew ? ' <span class="badge badge-new" style="padding:1px 6px;font-size:10px;">새</span>' : ""}${s.plannedClassName ? ` <span class="dim-note" style="font-size:11px;">(예정:${escapeHtml(s.plannedClassName)})</span>` : ""}</span>
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

  // 화면과 별개로, A4 1장 인쇄 전용 레이아웃도 함께 만들어 둔다 (인쇄 버튼 클릭 시 이 영역만 출력됨)
  // "합계"는 재적 학생만 집계하고(새친구는 재적 인원에 포함하지 않음), 새친구 인원은 별도로 표시한다.
  $("#reportPrintArea").innerHTML = buildPrintHtml(
    date, meta, offering, offeringTotal, details,
    { totalRoster: totalRegularRoster, totalPresent: totalRegularPresent, totalNewRoster, totalNewPresent }
  );

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

  // 이름을 누르면 재적부와 동일한 학생 프로필 모달(사진/연락처/보호자 등)이 뜸
  $("#reportBody").querySelectorAll(".student-name-link").forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      const id = e.currentTarget.dataset.studentId;
      const student = getStudentsCache().find(s => s.id === id);
      if (student) openStudentProfileModal(student);
    };
  });
}

// 기존에 쓰던 구글시트 "청소년부 주간보고서" 양식과 비슷하게, A4 용지 1장에 맞춰 인쇄할 수 있는
// 전용 레이아웃(HTML)을 만든다. 화면에 보이는 카드형 UI와는 별개로, 이 함수가 만든 내용만
// #reportPrintArea 안에 넣어두고 인쇄 시에는 CSS(@media print)로 이 영역만 보이게 처리한다.
// (사진 썸네일/배지 등 화면용 장식은 인쇄본에서는 생략하고, 이름+출결(O/X)만 최대한 촘촘하게 배치)
function buildPrintHtml(date, meta, offering, offeringTotal, details, totals) {
  const { totalRoster, totalPresent, totalNewRoster = 0, totalNewPresent = 0 } = totals;
  const [y, m, d] = date.split("-");
  const dateFormatted = `${y}년 ${m}월 ${d}일`;
  const weekBadge = fmtMonthDay(date);
  const author = currentUser.name || currentUser.email || "";
  const rate = totalRoster ? Math.round((totalPresent / totalRoster) * 1000) / 10 : 0;

  const classCards = details.map(cls => {
    const rows = cls.students.length
      ? cls.students.map(s => `
        <tr>
          <td class="rp-stu-name">${escapeHtml(s.name)}${s.plannedClassName ? `<br/><span style="font-size:7px;color:#888;">예정:${escapeHtml(s.plannedClassName)}</span>` : ""}</td>
          <td class="rp-stu-val rp-stu-${s.val === "O" ? "o" : "x"}">${s.val}</td>
        </tr>
      `).join("")
      : `<tr><td colspan="2" class="rp-stu-empty">학생 없음</td></tr>`;
    return `
      <div class="rp-class-card">
        <div class="rp-class-card-title">${escapeHtml(cls.className)}</div>
        <table class="rp-class-table">
          <thead><tr><th>재적</th><th>출석</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="rp-class-card-foot">재적 ${cls.roster} · 출석 ${cls.present}</div>
      </div>
    `;
  }).join("");

  const totalCard = `
    <div class="rp-class-card rp-total-card">
      <div class="rp-class-card-title">합계</div>
      <div class="rp-total-body">
        <p>재적 <strong>${totalRoster}</strong>명</p>
        <p>출석 <strong>${totalPresent}</strong>명</p>
        <p>결석 <strong>${totalRoster - totalPresent}</strong>명</p>
        <p class="rp-total-rate">${rate}%</p>
        ${totalNewRoster ? `<p style="font-size:9px;color:#868e96;margin-top:3px;">새친구 ${totalNewRoster}명 별도(미포함)</p>` : ""}
      </div>
    </div>
  `;

  return `
    <div class="rp-page">
      <table class="rp-head-table">
        <tr>
          <td class="rp-title" rowspan="2">청소년부<br/>주간보고서</td>
          <td class="rp-sign-h">부장</td>
          <td class="rp-sign-h">교역자</td>
          <td class="rp-sign-h">교육목사</td>
          <td class="rp-sign-h">담임목사</td>
        </tr>
        <tr>
          <td class="rp-sign-v">&nbsp;</td>
          <td class="rp-sign-v">&nbsp;</td>
          <td class="rp-sign-v">&nbsp;</td>
          <td class="rp-sign-v">&nbsp;</td>
        </tr>
        <tr>
          <td class="rp-label">일시</td>
          <td colspan="2">${dateFormatted} <span class="rp-week-badge">${weekBadge}</span></td>
          <td class="rp-label">작성자</td>
          <td>${escapeHtml(author)}</td>
        </tr>
        <tr>
          <td class="rp-label">설교본문</td>
          <td>${escapeHtml(meta.sermonText || "")}</td>
          <td class="rp-label">설교제목</td>
          <td colspan="2">${escapeHtml(meta.sermonTitle || "")}</td>
        </tr>
        <tr>
          <td class="rp-label">설교자</td>
          <td colspan="4">${escapeHtml(meta.preacher || "")}</td>
        </tr>
      </table>

      <div class="rp-mid">
        <div class="rp-mid-col rp-offering-col">
          <table class="rp-offering-table">
            <tr><th colspan="2">헌금 내역</th></tr>
            <tr><td>주일헌금</td><td>₩${(offering.weekly || 0).toLocaleString()}</td></tr>
            <tr><td>십일조</td><td>₩${(offering.tithe || 0).toLocaleString()}</td></tr>
            <tr><td>감사헌금</td><td>₩${(offering.thanks || 0).toLocaleString()}</td></tr>
            <tr><td>기타(절기 등)</td><td>₩${(offering.other || 0).toLocaleString()}</td></tr>
            <tr class="rp-offering-total-row"><td>합계</td><td>₩${offeringTotal.toLocaleString()}</td></tr>
          </table>
        </div>
        <div class="rp-mid-col">
          <div class="rp-mid-col-title">주간심방 및 기도제목 / 건의사항</div>
          <div class="rp-mid-col-body">${escapeHtml(meta.visitationNotes || "")}</div>
        </div>
        <div class="rp-mid-col">
          <div class="rp-mid-col-title">실시 및 예정 사항</div>
          <div class="rp-mid-col-body">${escapeHtml(meta.scheduleNotes || "")}</div>
        </div>
      </div>

      <div class="rp-section-bar">학생 출결 사항</div>
      <div class="rp-class-grid">
        ${classCards}
        ${totalCard}
      </div>
    </div>
  `;
}
