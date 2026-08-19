import {
  db, collection, doc, getDocs, setDoc, deleteDoc, query, where, serverTimestamp
} from "./firebase-init.js";
import {
  $, escapeHtml, getSundaysOfYear, fmtMonthDay, yearSelectOptionsHtml,
  openModal, closeModal, friendlyFirestoreError
} from "./utils.js";
import { currentUser } from "./auth.js";

// "연간계획" 화면: 첨부받은 엑셀(연간계획표) 서식처럼 한 해의 모든 주일을 1월~12월 쭉 나열하고,
// 그 주의 절기/교회행사/주일행사/청소년부행사/비고를 등록·수정·삭제할 수 있는 화면.
// weeklyMeta(예배정보입력)와 별개의 컬렉션(yearlyPlan)에 문서ID를 주일 날짜(YYYY-MM-DD)로 저장한다.

const PLAN_FIELDS = [
  { key: "season", label: "절기" },
  { key: "churchEvent", label: "교회행사" },
  { key: "sundayEvent", label: "주일행사" },
  { key: "youthEvent", label: "청소년부 행사" }
];

export async function initYearlyPlanView() {
  const thisYear = new Date().getFullYear();
  const yearSelect = $("#yearlyPlanYearSelect");
  yearSelect.innerHTML = yearSelectOptionsHtml(thisYear);
  yearSelect.onchange = renderYearlyPlanTable;
  await renderYearlyPlanTable();
}

async function fetchYearlyPlan(year) {
  const q = query(
    collection(db, "yearlyPlan"),
    where("date", ">=", `${year}-01-01`),
    where("date", "<=", `${year}-12-31`)
  );
  const snap = await getDocs(q);
  const byDate = {};
  snap.docs.forEach(d => { byDate[d.id] = d.data(); });
  return byDate;
}

async function renderYearlyPlanTable() {
  const year = Number($("#yearlyPlanYearSelect").value);
  const wrap = $("#yearlyPlanTableWrap");
  wrap.innerHTML = `<p style="padding:16px;color:#868e96;">불러오는 중...</p>`;

  let byDate;
  try {
    byDate = await fetchYearlyPlan(year);
  } catch (err) {
    console.error("연간계획 조회 실패", err);
    wrap.innerHTML = `<p class="list empty" style="padding:16px;line-height:1.6;color:#e03131;">${friendlyFirestoreError(err)}</p>`;
    return;
  }

  const sundays = getSundaysOfYear(year);

  // 같은 달의 주일끼리 묶어서 "월" 칸을 rowspan으로 합쳐 첨부 엑셀 서식과 비슷하게 보여줌
  const monthGroups = [];
  sundays.forEach(date => {
    const month = Number(date.split("-")[1]);
    const last = monthGroups[monthGroups.length - 1];
    if (!last || last.month !== month) {
      monthGroups.push({ month, dates: [date] });
    } else {
      last.dates.push(date);
    }
  });

  const rowsHtml = monthGroups.map(group => group.dates.map((date, idx) => {
    const entry = byDate[date];
    const hasContent = !!entry && (PLAN_FIELDS.some(f => entry[f.key]) || entry.note);
    const cells = PLAN_FIELDS.map(f =>
      `<td>${entry && entry[f.key] ? escapeHtml(entry[f.key]) : `<span class="dim-note">-</span>`}</td>`
    ).join("");
    return `
      <tr data-date="${date}" class="plan-row${hasContent ? " plan-row-filled" : ""}">
        ${idx === 0 ? `<td rowspan="${group.dates.length}" class="plan-month-cell">${group.month}월</td>` : ""}
        <td class="plan-date-cell">${fmtMonthDay(date)}</td>
        ${cells}
        <td>${entry && entry.note ? escapeHtml(entry.note) : `<span class="dim-note">-</span>`}</td>
        <td><button class="btn btn-sm planEditBtn" data-date="${date}">${hasContent ? "수정" : "등록"}</button></td>
      </tr>
    `;
  }).join("")).join("");

  wrap.innerHTML = `
    <table class="plan-table">
      <thead>
        <tr>
          <th>월</th><th>주일</th>
          ${PLAN_FIELDS.map(f => `<th>${f.label}</th>`).join("")}
          <th>비고</th><th></th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  wrap.querySelectorAll(".planEditBtn").forEach(btn => {
    btn.onclick = () => openPlanModal(btn.dataset.date, byDate[btn.dataset.date] || null);
  });
}

function openPlanModal(date, entry) {
  openModal(`
    <h3>연간계획 입력</h3>
    <p style="font-size:13px;color:#6b7280;margin:0 0 10px;">${escapeHtml(date)} (주일)</p>
    <label>절기</label>
    <input id="p_season" value="${escapeHtml(entry?.season || "")}" placeholder="예: 부활주일, 맥추감사주일" />
    <label>교회행사</label>
    <input id="p_churchEvent" value="${escapeHtml(entry?.churchEvent || "")}" placeholder="예: 월삭새벽예배(1), 느헤미야기도회" />
    <label>주일행사</label>
    <input id="p_sundayEvent" value="${escapeHtml(entry?.sundayEvent || "")}" placeholder="예: 찬양대 특별찬양, 학습세례입교식" />
    <label>청소년부 행사</label>
    <input id="p_youthEvent" value="${escapeHtml(entry?.youthEvent || "")}" placeholder="예: 신입생 환영회, 여름수련회" />
    <label>비고</label>
    <textarea id="p_note" rows="3" placeholder="추가로 남길 내용이 있으면 적어주세요.">${escapeHtml(entry?.note || "")}</textarea>
    <div class="modal-actions">
      ${entry ? `<button id="deletePlanBtn" class="btn btn-danger">삭제</button>` : ""}
      <button id="cancelBtn" class="btn">취소</button>
      <button id="savePlanBtn" class="btn btn-primary">저장</button>
    </div>
    <p id="planModalMsg" style="font-size:12.5px;color:#e03131;margin-top:8px;"></p>
  `, { wide: true });

  $("#cancelBtn").onclick = closeModal;

  if (entry) {
    $("#deletePlanBtn").onclick = async () => {
      if (!confirm(`${date} 연간계획 내용을 삭제할까요?`)) return;
      try {
        await deleteDoc(doc(db, "yearlyPlan", date));
      } catch (err) {
        $("#planModalMsg").textContent = `삭제 중 오류가 발생했습니다: ${err.message || err}`;
        return;
      }
      closeModal();
      renderYearlyPlanTable();
    };
  }

  $("#savePlanBtn").onclick = async () => {
    const season = $("#p_season").value.trim();
    const churchEvent = $("#p_churchEvent").value.trim();
    const sundayEvent = $("#p_sundayEvent").value.trim();
    const youthEvent = $("#p_youthEvent").value.trim();
    const note = $("#p_note").value.trim();

    try {
      await setDoc(doc(db, "yearlyPlan", date), {
        date, season, churchEvent, sundayEvent, youthEvent, note,
        updatedBy: currentUser.uid, updatedAt: serverTimestamp()
      });
    } catch (err) {
      $("#planModalMsg").textContent = `저장 중 오류가 발생했습니다: ${err.message || err}`;
      return;
    }
    closeModal();
    renderYearlyPlanTable();
  };
}
