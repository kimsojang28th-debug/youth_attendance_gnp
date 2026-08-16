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
export const STUDENT_STATUS_LABEL = {
  active: "재적",
  new: "새친구",
  hold: "보류",
  removed: "제적"
};

export const HISTORY_TYPE_LABEL = {
  active: "재적",
  new: "새친구 등록",
  transfer_in: "전입",
  transfer_out: "전출",
  leave: "휴학",
  hold: "보류",
  return: "복학/복귀",
  removed: "제적"
};

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
export function openModal(innerHtml) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal-box">${innerHtml}</div>`;
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
