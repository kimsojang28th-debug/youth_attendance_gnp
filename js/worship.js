import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase-init.js";
import {
  $, escapeHtml, nearestSundayISO, toast,
  yearSelectOptionsHtml, sundayOptionsHtmlForYear, getSundaysOfYear
} from "./utils.js";
import { currentUser } from "./auth.js";

// "예배정보입력" 화면: 설교/헌금/심방/실시예정 등 weeklyMeta 문서를 입력하는 화면.
// (반별 출석체크를 각 교사가 입력하는 것처럼, 이 화면은 예배 관련 정보를 입력하는 용도이고
// 실제 결과 확인은 "주간보고서" 화면에서 읽기 전용으로 봄)

export async function initWorshipView() {
  const thisYear = new Date().getFullYear();
  const yearSelect = $("#worshipYearSelect");
  yearSelect.innerHTML = yearSelectOptionsHtml(thisYear);

  const dateSelect = $("#worshipDate");
  dateSelect.innerHTML = sundayOptionsHtmlForYear(thisYear, nearestSundayISO());

  yearSelect.onchange = () => {
    const year = Number(yearSelect.value);
    const defaultDate = year === new Date().getFullYear() ? nearestSundayISO() : getSundaysOfYear(year)[0];
    dateSelect.innerHTML = sundayOptionsHtmlForYear(year, defaultDate);
  };

  $("#loadWorshipBtn").onclick = renderWorshipForm;
  await renderWorshipForm();
}

async function getWeeklyMeta(date) {
  const snap = await getDoc(doc(db, "weeklyMeta", date));
  return snap.exists() ? snap.data() : {};
}

async function renderWorshipForm() {
  const date = $("#worshipDate").value;
  if (!date) return;
  const meta = await getWeeklyMeta(date);
  const offering = meta.offering || {};
  const offeringTotal = ["weekly", "tithe", "thanks", "other"]
    .reduce((sum, k) => sum + (Number(offering[k]) || 0), 0);

  $("#worshipBody").innerHTML = `
    <div class="panel">
      <h3>설교 및 예배 정보</h3>
      <div class="card-grid">
        <div><label>설교 본문</label><input id="m_sermonText" value="${escapeHtml(meta.sermonText || "")}" /></div>
        <div><label>설교 제목</label><input id="m_sermonTitle" value="${escapeHtml(meta.sermonTitle || "")}" /></div>
        <div><label>설교자</label><input id="m_preacher" value="${escapeHtml(meta.preacher || "")}" /></div>
      </div>
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
      <textarea id="m_visitationNotes" class="worship-textarea" rows="6">${escapeHtml(meta.visitationNotes || "")}</textarea>
    </div>

    <div class="panel">
      <h3>실시 및 예정 사항</h3>
      <textarea id="m_scheduleNotes" class="worship-textarea" rows="6">${escapeHtml(meta.scheduleNotes || "")}</textarea>
    </div>

    <button id="saveMetaBtn" class="btn btn-primary">예배정보 저장</button>
    <p id="worshipSaveMsg" class="save-msg"></p>
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
    toast("예배정보가 저장되었습니다.", $("#worshipSaveMsg"));
  };
}
