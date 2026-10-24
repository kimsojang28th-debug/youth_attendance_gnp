// 공용 유틸리티 함수 모음

export const $ = (sel, root = document) => root.querySelector(sel);
export const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// 2026-08-16: 학생 상태를 5개(재적/새친구/휴학/전출/제적)에서 4개(재적/새친구/보류/제적)로 단순화.
// 기존의 "휴학"/"전출"은 하나의 "보류" 상태로 통합됨(js/students.js의 일괄 정리 도구로 기존 데이터도 이관 가능).
// 2026-08-23(5차): 고3 학생이 청년부로 넘어가는 것을 표현하기 위해 "졸업" 상태를 추가함(5개: 재적/새친구/보류/제적/졸업).
export const STUDENT_STATUS_LABEL = {
  active: "재적",
  new: "새친구",
  hold: "보류",
  removed: "제적",
  graduated: "졸업"
};

// 2026-08-23(5차): 재적변동이력의 "구분"이 학생 상태값과 따로 놀고 있던 것을 통일함.
// 새로 입력할 때 고를 수 있는 구분은 학생 상태값과 완전히 동일한 5개(재적/새친구/보류/제적/졸업)뿐이며,
// 아래 HISTORY_TYPE_OPTIONS가 그 선택 목록임. 예전에 쓰이던 전입/전출/휴학/복학·복귀는 더 이상 새로
// 선택할 수 없지만, 과거에 이미 저장된 기록을 화면에 표시할 때 라벨이 깨지지 않도록 여기 남겨둠.
export const HISTORY_TYPE_LABEL = {
  active: "재적",
  new: "새친구",
  hold: "보류",
  removed: "제적",
  graduated: "졸업",
  // 하위호환용(신규 선택 불가, 과거 데이터 표시 전용)
  transfer_in: "전입",
  transfer_out: "전출",
  leave: "휴학",
  return: "복학/복귀"
};

// 재적변동이력 추가/수정 모달에서 실제로 선택 가능한 구분 목록 (학생 상태값과 동일한 순서로 통일)
export const HISTORY_TYPE_OPTIONS = ["active", "new", "hold", "removed", "graduated"];

// Date 객체를 "지역(로컬) 달력 기준" YYYY-MM-DD 문자열로 변환.
// (주의) Date.prototype.toISOString()은 UTC로 변환하기 때문에, 한국(UTC+9)처럼
// UTC보다 빠른 시간대에서는 자정 근처 시각에 날짜가 하루 앞당겨지는 버그가 생깁니다.
// 이 앱의 모든 날짜 계산은 반드시 이 함수를 통해서만 문자열로 만들어야 합니다.
function toLocalISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayISO() {
  return toLocalISODate(new Date());
}

// 해당 연도의 모든 주일(일요일) 날짜 목록을 YYYY-MM-DD 로 반환
export function getSundaysOfYear(year) {
  const sundays = [];
  const d = new Date(year, 0, 1);
  // 1월 1일이 있는 주의 일요일로 이동
  const dow = d.getDay(); // 0=일요일
  d.setDate(d.getDate() - dow);
  if (d.getFullYear() < year) d.setDate(d.getDate() + 7);
  while (d.getFullYear() === year) {
    sundays.push(toLocalISODate(d));
    d.setDate(d.getDate() + 7);
  }
  return sundays;
}

// 가장 최근 지난 일요일(오늘 포함) 날짜
export function nearestSundayISO(base = new Date()) {
  const d = new Date(base);
  const dow = d.getDay();
  d.setDate(d.getDate() - dow);
  return toLocalISODate(d);
}

export function fmtMonthDay(iso) {
  const [, m, day] = iso.split("-");
  return `${Number(m)}/${Number(day)}`;
}

export function attendanceRate(o, total) {
  if (!total) return 0;
  return Math.round((o / total) * 1000) / 10; // 소수 첫째 자리
}

// 이름 기준 가나다순 정렬 (한국어 로케일). 원본 배열은 건드리지 않습니다.
export function sortByName(list) {
  return [...list].sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));
}

// 연도 선택 <select> 옵션 HTML 생성. 기준연도의 전후 1년씩, 총 3개 연도를 제공합니다.
// (예: 올해가 2026년이면 2025/2026/2027년이 나오고, 기본값은 올해가 선택됩니다.)
export function yearSelectOptionsHtml(selectedYear) {
  const years = [selectedYear - 1, selectedYear, selectedYear + 1];
  return years.map(y => `<option value="${y}" ${y === selectedYear ? "selected" : ""}>${y}년</option>`).join("");
}

// 주일(일요일)만 선택 가능한 <select> 옵션 HTML 생성 (지정한 한 해의 주일만).
// 연도를 먼저 고르고 그 연도의 주일만 보이도록 할 때 사용합니다.
export function sundayOptionsHtmlForYear(year, selectedDate) {
  return getSundaysOfYear(year).map(d =>
    `<option value="${d}" ${d === selectedDate ? "selected" : ""}>${d} (일)</option>`
  ).join("");
}

// 간단한 토스트 메시지
export function toast(msg, el) {
  if (el) {
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 3000);
  }
}

// 모달 열기/닫기
// opts.wide: 학생 프로필처럼 내용이 많은 모달을 더 넓게 띄우고 싶을 때 true로 전달
export function openModal(innerHtml, opts = {}) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal-box${opts.wide ? " modal-wide" : ""}">${innerHtml}</div>`;
  root.classList.remove("hidden");
  root.onclick = (e) => { if (e.target === root) closeModal(); };
}
export function closeModal() {
  const root = $("#modalRoot");
  root.classList.add("hidden");
  root.innerHTML = "";
}

// CSV 한 줄 파싱 (쉼표/탭 모두 지원)
export function parseDelimitedLine(line) {
  return line.includes("\t") ? line.split("\t") : line.split(",");
}

// Firestore 오류 메시지에서 "색인을 만들어야 합니다" 링크를 추출해 사용자에게 보여줄 안내문(HTML) 생성
export function friendlyFirestoreError(err) {
  const msg = String(err?.message || err || "");
  const urlMatch = msg.match(/https:\/\/console\.firebase\.google\.com\S*/);
  if (urlMatch) {
    const url = urlMatch[0].replace(/["')]+$/, "");
    return `Firestore 색인(index)이 아직 만들어지지 않았습니다. 아래 링크를 눌러 "색인 만들기"를 누른 뒤, 1~2분 후 다시 시도해주세요.<br/><a href="${url}" target="_blank" rel="noopener" style="word-break:break-all;">${url}</a>`;
  }
  return `데이터를 불러오지 못했습니다: ${escapeHtml(msg) || "알 수 없는 오류"}`;
}


// 음력 변환 (브라우저 내장 Intl의 중국력 사용) - 월별 생일자 화면과 대시보드 캘린더가 함께 씀.
// 양력 y년 m0월(0~11) d일이 음력 몇 월 몇 일인지 {m, d}로 돌려줌. 윤달이거나 브라우저가 지원하지 않으면 null.
let _lunarFmt = null;
try { _lunarFmt = new Intl.DateTimeFormat("en-u-ca-chinese", { month: "numeric", day: "numeric" }); } catch (e) { _lunarFmt = null; }
export function lunarMonthDay(y, m0, d) {
  if (!_lunarFmt) return null;
  try {
    const parts = _lunarFmt.formatToParts(new Date(y, m0, d, 12));
    const mp = parts.find(p => p.type === "month")?.value || "";
    const dp = parts.find(p => p.type === "day")?.value || "";
    if (/bis/i.test(mp)) return null;
    return { m: parseInt(mp, 10), d: parseInt(dp, 10) };
  } catch (e) { return null; }
}


// ---------------------------------------------------------------------------
// 전화번호: 숫자만 입력해도 하이픈이 자동으로 붙도록 정리
// ---------------------------------------------------------------------------
export const phoneDigits = (v) => String(v || "").replace(/\D/g, "");

export function formatPhone(v) {
  const raw = String(v || "").trim();
  if (raw.startsWith("+")) return raw; // 해외 번호는 그대로 둠
  const d = phoneDigits(raw).slice(0, 11);
  if (!d) return "";
  if (d.startsWith("02")) {
    const x = d.slice(0, 10);
    if (x.length <= 2) return x;
    if (x.length <= 6) return `${x.slice(0, 2)}-${x.slice(2)}`;
    return `${x.slice(0, 2)}-${x.slice(2, x.length - 4)}-${x.slice(-4)}`;
  }
  if (d.startsWith("010")) {
    if (d.length <= 3) return d;
    if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
    return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  }
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(-4)}`;
}

// data-phone 속성이 있는 입력칸은 입력하는 즉시 형식을 맞춘다(커서 위치 유지)
if (typeof document !== "undefined") {
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || !el.hasAttribute("data-phone") || e.isComposing) return;
    const before = el.value;
    const caret = el.selectionStart ?? before.length;
    const digitsBefore = phoneDigits(before.slice(0, caret)).length;
    const after = formatPhone(before);
    if (after === before) return;
    el.value = after;
    let pos = 0, cnt = 0;
    while (pos < after.length && cnt < digitsBefore) { if (/\d/.test(after[pos])) cnt++; pos++; }
    try { el.setSelectionRange(pos, pos); } catch (err) { /* 일부 입력칸은 커서 이동 불가 */ }
  });
}

// ---------------------------------------------------------------------------
// 삭제 확인: 삭제할 이름을 직접 입력해야 진행됨
// ---------------------------------------------------------------------------
export function confirmTypeName({ title, name, bodyHtml = "", confirmLabel = "삭제" }) {
  return new Promise((resolve) => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const ov = document.createElement("div");
    ov.className = "type-confirm-overlay";
    ov.innerHTML = `
      <div class="type-confirm-box" role="dialog" aria-modal="true">
        <h3>${escapeHtml(title)}</h3>
        <div class="type-confirm-body">${bodyHtml}</div>
        <p>삭제하려면 아래에 이름 <b>${escapeHtml(name)}</b> 을(를) 그대로 입력해주세요.</p>
        <input type="text" class="type-confirm-input" autocomplete="off" placeholder="${escapeHtml(name)}" />
        <div class="modal-actions">
          <button type="button" class="btn tc-cancel">취소</button>
          <button type="button" class="btn btn-danger tc-ok" disabled>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector(".type-confirm-input");
    const ok = ov.querySelector(".tc-ok");
    const done = (v) => { ov.remove(); resolve(v); };
    input.oninput = () => { ok.disabled = norm(input.value) !== norm(name); };
    input.onkeydown = (e) => { if (e.key === "Enter" && !ok.disabled) done(true); if (e.key === "Escape") done(false); };
    ov.querySelector(".tc-cancel").onclick = () => done(false);
    ok.onclick = () => done(true);
    setTimeout(() => input.focus(), 50);
  });
}
