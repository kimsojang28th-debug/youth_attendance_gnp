import {
  db, collection, doc, getDocs, setDoc, deleteDoc, query, where, serverTimestamp
} from "./firebase-init.js";
import {
  $, $all, escapeHtml, getSundaysOfYear, fmtMonthDay, yearSelectOptionsHtml,
  openModal, closeModal, friendlyFirestoreError, nearestSundayISO
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

// 2026-10-24 개편: 기본 화면을 "월별 카드"로 바꿈 - 내용이 있는 주일만 색 라벨과 함께 크게 보여주고, 빈 주일은 접어 둠.
// 예전의 52주 전체 표는 "전체 표" 버튼으로 그대로 볼 수 있음.
const PLAN_TAGS = [
  { key: "youthEvent", label: "청소년부", cls: "youth" },
  { key: "season", label: "절기", cls: "season" },
  { key: "churchEvent", label: "교회", cls: "church" },
  { key: "sundayEvent", label: "주일", cls: "sunday" }
];

let _byDate = {};
let _mode = "cards";
let _scrollToNow = true;

export async function initYearlyPlanView() {
  const thisYear = new Date().getFullYear();
  const yearSelect = $("#yearlyPlanYearSelect");
  yearSelect.innerHTML = yearSelectOptionsHtml(thisYear);
  yearSelect.onchange = () => { _scrollToNow = true; renderYearlyPlan(); };
  try { _mode = localStorage.getItem("youth:planView") === "table" ? "table" : "cards"; } catch (e) { _mode = "cards"; }
  $all(".plan-mode-btn").forEach(b => {
    b.onclick = () => {
      _mode = b.dataset.mode;
      try { localStorage.setItem("youth:planView", _mode); } catch (e) { /* 무시 */ }
      _scrollToNow = true;
      paintPlan();
    };
  });
  _scrollToNow = true;
  await renderYearlyPlan();
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

async function renderYearlyPlan() {
  const year = Number($("#yearlyPlanYearSelect").value);
  const cardsWrap = $("#yearlyPlanCardsWrap");
  cardsWrap.innerHTML = `<p style="padding:16px;color:#868e96;">불러오는 중...</p>`;
  try {
    _byDate = await fetchYearlyPlan(year);
  } catch (err) {
    console.error("연간계획 조회 실패", err);
    cardsWrap.innerHTML = `<p class="list empty" style="padding:16px;line-height:1.6;color:#e03131;">${friendlyFirestoreError(err)}</p>`;
    return;
  }
  paintPlan();
}

function paintPlan() {
  const year = Number($("#yearlyPlanYearSelect").value);
  $all(".plan-mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === _mode));
  $("#yearlyPlanCardsWrap").classList.toggle("hidden", _mode !== "cards");
  $("#yearlyPlanTableWrap").classList.toggle("hidden", _mode !== "table");
  if (_mode === "cards") renderPlanCards(year, _byDate); else renderPlanTable(year, _byDate);
}

function hasPlanContent(entry) {
  return !!entry && (PLAN_FIELDS.some(f => entry[f.key]) || entry.note);
}

function renderPlanCards(year, byDate) {
  const wrap = $("#yearlyPlanCardsWrap");
  const sundays = getSundaysOfYear(year);
  const thisSunday = nearestSundayISO();
  const now = new Date();
  const isThisYear = year === now.getFullYear();
  const isPastYear = year < now.getFullYear();

  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, filled: [], empty: [] }));
  sundays.forEach(date => {
    const m = months[Number(date.split("-")[1]) - 1];
    (hasPlanContent(byDate[date]) ? m.filled : m.empty).push(date);
  });

  const mdLabel = (date) => fmtMonthDay(date);

  wrap.innerHTML = months.map(m => {
    const isNowMonth = isThisYear && m.month === now.getMonth() + 1;
    const entries = m.filled.map(date => {
      const e = byDate[date];
      const past = isPastYear || (isThisYear && date < thisSunday);
      const isNowWeek = isThisYear && date === thisSunday;
      const lines = PLAN_TAGS.filter(t => e[t.key]).map(t =>
        `<span class="plan-line plan-line-${t.cls}"><span class="plan-tag plan-tag-${t.cls}">${t.label}</span><span>${escapeHtml(e[t.key])}</span></span>`
      ).join("");
      return `
        <button type="button" class="plan-entry${past ? " past" : ""}${isNowWeek ? " now" : ""}" data-date="${date}">
          <span class="plan-entry-date">${mdLabel(date)}${isNowWeek ? `<small>이번 주</small>` : ""}</span>
          <span class="plan-entry-body">${lines}${e.note ? `<span class="plan-note">${escapeHtml(e.note)}</span>` : ""}</span>
          <span class="plan-edit" aria-hidden="true">✎</span>
        </button>`;
    }).join("");
    const emptyBlock = m.empty.length ? `
      <details class="plan-empty">
        <summary>${m.filled.length ? `빈 주일 ${m.empty.length}개` : "등록된 계획 없음"} · 눌러서 등록</summary>
        <div class="plan-empty-list">${m.empty.map(d => `<button type="button" class="plan-empty-btn" data-date="${d}">${mdLabel(d)} +</button>`).join("")}</div>
      </details>` : "";
    return `
      <section class="plan-month-card${isNowMonth ? " is-now" : ""}" data-month="${m.month}">
        <h3>${m.month}월${isNowMonth ? `<span class="plan-now-badge">이번 달</span>` : ""}</h3>
        ${entries}${emptyBlock}
      </section>`;
  }).join("");

  wrap.querySelectorAll(".plan-entry, .plan-empty-btn").forEach(el => {
    el.onclick = () => openPlanModal(el.dataset.date, byDate[el.dataset.date] || null);
  });

  // 처음 열었을 때(또는 연도를 바꿨을 때) 이번 달 카드가 보이도록 이동. 저장 후 다시 그릴 때는 이동하지 않음.
  if (_scrollToNow && isThisYear && now.getMonth() >= 3) {
    wrap.querySelector(".plan-month-card.is-now")?.scrollIntoView({ block: "start" });
  }
  _scrollToNow = false;
}

function renderPlanTable(year, byDate) {
  const wrap = $("#yearlyPlanTableWrap");
  const sundays = getSundaysOfYear(year);
  const thisSunday = nearestSundayISO();
  const nowYear = new Date().getFullYear();

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
    const hasContent = hasPlanContent(entry);
    const isNow = year === nowYear && date === thisSunday;
    const isPast = year < nowYear || (year === nowYear && date < thisSunday);
    const cells = PLAN_FIELDS.map(f =>
      `<td class="${f.key === "youthEvent" ? "plan-cell-youth" : ""}">${entry && entry[f.key] ? escapeHtml(entry[f.key]) : `<span class="dim-note">-</span>`}</td>`
    ).join("");
    return `
      <tr data-date="${date}" class="plan-row${hasContent ? " plan-row-filled" : ""}${isNow ? " now" : ""}${isPast ? " past" : ""}">
        ${idx === 0 ? `<td rowspan="${group.dates.length}" class="plan-month-cell">${group.month}월</td>` : ""}
        <td class="plan-date-cell">${fmtMonthDay(date)}${isNow ? `<small class="plan-now-mark">이번 주</small>` : ""}</td>
        ${cells}
        <td>${entry && entry.note ? escapeHtml(entry.note) : `<span class="dim-note">-</span>`}</td>
      </tr>
    `;
  }).join("")).join("");

  // 월/주일 칸은 폭을 최소로 줄여 왼쪽에 고정하고, 줄(행)을 누르면 바로 입력/수정 팝업이 열림
  wrap.innerHTML = `
    <table class="plan-table">
      <thead>
        <tr>
          <th class="plan-col-month">월</th><th class="plan-col-date">주일</th>
          ${PLAN_FIELDS.map(f => `<th>${f.label}</th>`).join("")}
          <th>비고</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  wrap.querySelectorAll(".plan-row").forEach(row => {
    row.onclick = () => openPlanModal(row.dataset.date, byDate[row.dataset.date] || null);
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
      renderYearlyPlan();
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
    renderYearlyPlan();
  };
}
