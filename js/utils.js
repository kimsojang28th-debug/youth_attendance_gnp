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

export const STUDENT_STATUS_LABEL = {
  active: "재적",
  new: "새친구",
  leave: "휴학",
  transferred_out: "전출",
  removed: "제적"
};

export const HISTORY_TYPE_LABEL = {
  new: "새친구 등록",
  transfer_in: "전입",
  transfer_out: "전출",
  leave: "휴학",
  return: "복학/복귀",
  removed: "제적"
};

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
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
    sundays.push(new Date(d).toISOString().slice(0, 10));
    d.setDate(d.getDate() + 7);
  }
  return sundays;
}

// 가장 최근 지난 일요일(오늘 포함) 날짜
export function nearestSundayISO(base = new Date()) {
  const d = new Date(base);
  const dow = d.getDay();
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function fmtMonthDay(iso) {
  const [, m, day] = iso.split("-");
  return `${Number(m)}/${Number(day)}`;
}

export function attendanceRate(o, total) {
  if (!total) return 0;
  return Math.round((o / total) * 1000) / 10; // 소수 첫째 자리
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
