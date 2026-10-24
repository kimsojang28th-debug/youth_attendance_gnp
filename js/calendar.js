import {
  db, collection, doc, getDocs, addDoc, updateDoc, deleteDoc, query, where, serverTimestamp
} from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { loadTeachers, getTeachersCache } from "./teachers.js";
import { $, $all, escapeHtml, todayISO, openModal, closeModal, lunarMonthDay } from "./utils.js";
import { currentUser } from "./auth.js";

// 대시보드 월간 캘린더 (2026-10-24 추가)
// - 연간계획(주일 행사표)과는 별개로, 날짜를 자유롭게 골라 일정을 추가/수정/삭제할 수 있음 (컬렉션: events)
// - 학생 생일, 교사 생일(음력 생일 포함)도 함께 표시. 출석 정보는 넣지 않음(출석은 연간출석부/주간보고서에서 확인)
// - 위쪽 토글 칩으로 일정/학생 생일/교사 생일을 켜고 끌 수 있음
// - 날짜를 누르면 오른쪽(모바일에서는 아래) "선택한 날" 카드에 그날의 일정과 생일이 나오고, 거기서 일정을 추가

const EVENT_TYPES = {
  youth:   { label: "청소년부", color: "#23405f" },
  church:  { label: "교회",     color: "#b7791f" },
  meeting: { label: "교사 모임", color: "#3f8a5a" },
  etc:     { label: "기타",     color: "#8a6a9a" }
};
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const PREF_KEY = "youth:calendarShow";

const state = {
  year: 0, month: 0,            // 보고 있는 달 (month: 0~11)
  selected: "",                 // 선택한 날짜 YYYY-MM-DD
  show: { events: true, student: true, teacher: true },
  events: [],                   // 불러온 일정
  eventsYear: null,             // events를 불러온 기준 연도
  eventsError: "",
  birthdaySolar: { student: {}, teacher: {} },   // "MM-DD" -> [{name, sub}]
  teacherLunar: []                                // [{name, m, d}]
};

const pad = (n) => String(n).padStart(2, "0");
const isoOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dowOf = (iso) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))).getDay();
const labelOf = (iso) => `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일 (${WEEKDAYS[dowOf(iso)]})`;

const lunarOf = lunarMonthDay;

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || "null");
    if (saved && typeof saved === "object") Object.assign(state.show, saved);
  } catch (e) { /* 저장소를 못 쓰는 환경이면 기본값 사용 */ }
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(state.show)); } catch (e) { /* 무시 */ }
}

// ---------------------------------------------------------------------------
// 데이터 불러오기
// ---------------------------------------------------------------------------
async function loadEvents(year, force = false) {
  if (!force && state.eventsYear === year && !state.eventsError) return;
  try {
    // 전년도 1월 ~ 다음해 12월 범위를 한 번에 불러와서, 연말/연초를 넘나드는 달 이동에도 다시 조회하지 않게 함
    const snap = await getDocs(query(
      collection(db, "events"),
      where("date", ">=", `${year - 1}-01-01`),
      where("date", "<=", `${year + 1}-12-31`)
    ));
    state.events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    state.eventsError = "";
  } catch (err) {
    console.error("일정 조회 실패", err);
    state.events = [];
    state.eventsError = (err && err.code === "permission-denied")
      ? "일정을 불러올 권한이 없습니다. Firebase 규칙에 events 컬렉션 설정이 필요합니다(관리자에게 문의)."
      : "일정을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.";
  }
  state.eventsYear = year;
}

function buildBirthdayIndex() {
  const classes = getClassesCache();
  const className = Object.fromEntries(classes.map(c => [c.id, c.name]));
  const solar = { student: {}, teacher: {} };
  const lunar = [];

  getStudentsCache().forEach(s => {
    if (s.status === "removed" || s.status === "graduated") return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.birthday || "")) return;
    (solar.student[s.birthday.slice(5)] ||= []).push({ name: s.name, sub: className[s.classId] || "" });
  });
  getTeachersCache().forEach(t => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.birthday || "")) return;
    const md = t.birthday.slice(5);
    if (t.lunar) lunar.push({ name: t.name, m: Number(md.slice(0, 2)), d: Number(md.slice(3, 5)) });
    else (solar.teacher[md] ||= []).push({ name: t.name, sub: "교사" });
  });
  state.birthdaySolar = solar;
  state.teacherLunar = lunar;
}

// ---------------------------------------------------------------------------
// 날짜별 항목 계산
// ---------------------------------------------------------------------------
function eventsOn(iso) {
  return state.events
    .filter(e => e.date <= iso && (e.endDate || e.date) >= iso)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.title).localeCompare(String(b.title), "ko")));
}

function birthdaysOn(iso) {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) - 1, d = Number(iso.slice(8, 10));
  const key = iso.slice(5);
  const pick = (map) => {
    const list = [...(map[key] || [])];
    // 2월 29일생은 평년에는 2월 28일에 표시
    if (key === "02-28" && !isLeap(y)) list.push(...(map["02-29"] || []));
    return list;
  };
  const students = pick(state.birthdaySolar.student);
  const teachers = pick(state.birthdaySolar.teacher).map(t => ({ ...t }));
  if (state.teacherLunar.length) {
    const l = lunarOf(y, m, d);
    if (l) state.teacherLunar.forEach(t => { if (t.m === l.m && t.d === l.d) teachers.push({ name: t.name, sub: "교사 · 음력" }); });
  }
  return { students, teachers };
}

// ---------------------------------------------------------------------------
// 화면 그리기
// ---------------------------------------------------------------------------
// 같은 달력을 두 곳에서 쓴다: 대시보드(#dashboardCalendar)와 "일정 > 월간 일정" 화면(#scheduleCalendar).
// 달력 안의 id(calPanel 등)가 겹치지 않도록 한 번에 한 곳에만 그리고, 다른 쪽은 비워둔다.
let hostId = "dashboardCalendar";
const getHost = () => $("#" + hostId);

export const initDashboardCalendar = () => initCalendarIn("dashboardCalendar");
export const initScheduleCalendar = () => initCalendarIn("scheduleCalendar");

async function initCalendarIn(id) {
  hostId = id;
  ["dashboardCalendar", "scheduleCalendar"].forEach(other => { if (other !== id) { const el = $("#" + other); if (el) el.innerHTML = ""; } });
  const host = getHost();
  if (!host) return;
  loadPrefs();
  // 대시보드를 열 때마다 이번 달/오늘부터 시작
  const now = new Date();
  state.year = now.getFullYear();
  state.month = now.getMonth();
  state.selected = todayISO();
  host.innerHTML = `<div class="panel cal-panel"><p class="dim-note">캘린더를 불러오는 중...</p></div>`;
  await Promise.all([
    loadClasses().catch(() => {}), loadStudents().catch(() => {}), loadTeachers().catch(() => {}),
    loadEvents(state.year, true)
  ]);
  buildBirthdayIndex();
  render();
}

function render() {
  const host = getHost();
  if (!host) return;
  const { year, month } = state;
  const today = todayISO();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = first.getDay();
  const weeks = Math.ceil((lead + daysInMonth) / 7);

  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const dt = new Date(year, month, 1 - lead + i);
    const iso = isoOf(dt.getFullYear(), dt.getMonth(), dt.getDate());
    cells.push({ iso, day: dt.getDate(), out: dt.getMonth() !== month, dow: dt.getDay() });
  }

  const cellHtml = cells.map(c => {
    const evs = state.show.events ? eventsOn(c.iso) : [];
    const bd = birthdaysOn(c.iso);
    const stu = state.show.student ? bd.students : [];
    const tea = state.show.teacher ? bd.teachers : [];

    const chips = [];
    evs.forEach(e => chips.push(`<span class="cal-chip" title="${escapeHtml(e.title)}" style="--c:${(EVENT_TYPES[e.type] || EVENT_TYPES.etc).color}">${escapeHtml(e.title)}</span>`));
    if (stu.length) chips.push(`<span class="cal-chip cal-chip-bd" title="${escapeHtml(stu.map(x => x.name).join(", "))}">🎂&nbsp;${escapeHtml(stu[0].name)}${stu.length > 1 ? ` 외 ${stu.length - 1}명` : ""}</span>`);
    if (tea.length) chips.push(`<span class="cal-chip cal-chip-bd cal-chip-bd-t" title="${escapeHtml(tea.map(x => x.name).join(", "))} (교사)">🎂&nbsp;${escapeHtml(tea[0].name)}${tea.length > 1 ? ` 외 ${tea.length - 1}명` : ""}</span>`);
    // 일정 이름이 점이 아니라 글자로 보이도록: PC는 4개까지, 모바일(좁은 칸)은 2개까지 보이고 나머지는 +N으로 표시(CSS로 전환)
    const shown = chips.slice(0, 4).join("");
    const more = (chips.length > 4 ? `<span class="cal-more cal-more-pc">+${chips.length - 4}</span>` : "") +
                 (chips.length > 2 ? `<span class="cal-more cal-more-m">+${chips.length - 2}</span>` : "");

    const cls = ["cal-cell"];
    if (c.out) cls.push("out");
    if (c.dow === 0) cls.push("sun");
    if (c.dow === 6) cls.push("sat");
    if (c.iso === today) cls.push("today");
    if (c.iso === state.selected) cls.push("sel");
    return `<div class="${cls.join(" ")}" data-date="${c.iso}" role="button" tabindex="0" aria-label="${labelOf(c.iso)}">
      <span class="cal-num">${c.day}</span>
      <div class="cal-items">${shown}${more}</div>
    </div>`;
  }).join("");

  host.innerHTML = `
    <div class="cal-layout">
     <div class="cal-main">
      <div class="panel cal-panel" id="calPanel">
        <div class="cal-head">
          <div class="cal-nav">
            <button type="button" class="btn btn-sm" id="calPrev" aria-label="이전 달">◀</button>
            <h3 class="cal-title">${year}년 ${month + 1}월</h3>
            <button type="button" class="btn btn-sm" id="calNext" aria-label="다음 달">▶</button>
            <button type="button" class="btn btn-sm" id="calToday">오늘</button>
          </div>
          <button type="button" class="btn btn-primary btn-sm" id="calAdd">+ 일정 추가</button>
        </div>
        <div class="cal-chips">
          <button type="button" class="cal-toggle ${state.show.events ? "on" : ""}" data-key="events">📌 일정</button>
          <button type="button" class="cal-toggle ${state.show.student ? "on" : ""}" data-key="student">🎂 학생 생일</button>
          <button type="button" class="cal-toggle ${state.show.teacher ? "on" : ""}" data-key="teacher">🎂 교사 생일</button>
          <span class="cal-legend">${Object.values(EVENT_TYPES).map(t => `<span><i style="background:${t.color}"></i>${t.label}</span>`).join("")}</span>
        </div>
        ${state.eventsError ? `<p class="error-text cal-error">${escapeHtml(state.eventsError)}</p>` : ""}
        <div class="cal-grid cal-weekdays">${WEEKDAYS.map((w, i) => `<div class="${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</div>`).join("")}</div>
        <div class="cal-grid cal-days">${cellHtml}</div>
      </div>
      <div class="panel" id="calMonthList"></div>
     </div>
      <div class="cal-side">
        <div class="panel" id="calDetail"></div>
        <div class="panel" id="calUpcoming"></div>
      </div>
    </div>`;

  renderDetail();
  renderMonthList();
  renderUpcoming();
  bindCalendar();
}

function itemRowEvent(e, withDate) {
  const t = EVENT_TYPES[e.type] || EVENT_TYPES.etc;
  const range = e.endDate && e.endDate !== e.date ? `${e.date.slice(5).replace("-", "/")} ~ ${e.endDate.slice(5).replace("-", "/")}` : "";
  return `<div class="cal-item" style="--c:${t.color}">
    <div class="cal-item-main">
      <div class="cal-item-title">${withDate ? `<span class="cal-item-date">${Number(e.date.slice(5, 7))}/${Number(e.date.slice(8, 10))}(${WEEKDAYS[dowOf(e.date)]})</span> ` : ""}${escapeHtml(e.title)}</div>
      <div class="cal-item-sub">${t.label}${range ? ` · ${range}` : ""}${e.note ? ` · ${escapeHtml(e.note)}` : ""}</div>
    </div>
    <button type="button" class="btn btn-ghost btn-sm cal-edit" data-id="${e.id}" aria-label="일정 수정">✏️</button>
  </div>`;
}

function renderDetail() {
  const iso = state.selected;
  const el = $("#calDetail");
  if (!el) return;
  const evs = eventsOn(iso);
  const bd = birthdaysOn(iso);
  const stuHtml = bd.students.map(b => `<div class="cal-item cal-item-bd"><div class="cal-item-main"><div class="cal-item-title">🎂 ${escapeHtml(b.name)}</div><div class="cal-item-sub">학생${b.sub ? ` · ${escapeHtml(b.sub)}` : ""}</div></div></div>`).join("");
  const teaHtml = bd.teachers.map(b => `<div class="cal-item cal-item-bd cal-item-bd-t"><div class="cal-item-main"><div class="cal-item-title">🎂 ${escapeHtml(b.name)}</div><div class="cal-item-sub">${escapeHtml(b.sub)}</div></div></div>`).join("");
  const body = evs.map(e => itemRowEvent(e, false)).join("") + stuHtml + teaHtml;
  el.innerHTML = `
    <div class="cal-side-head"><h3>${labelOf(iso)}</h3><button type="button" class="btn btn-sm" id="calAddHere">+ 일정 추가</button></div>
    ${body || `<p class="dim-note" style="margin:6px 0 0;">등록된 일정이 없습니다.</p>`}`;
}

// "이번 달 전체 일정": 달력 칸을 눌러보지 않아도 그 달의 일정과 생일이 날짜순으로 한눈에 보이는 목록
function renderMonthList() {
  const el = $("#calMonthList");
  if (!el) return;
  const { year, month } = state;
  const last = new Date(year, month + 1, 0).getDate();
  const monthStart = isoOf(year, month, 1), monthEnd = isoOf(year, month, last);
  const rows = {};
  const row = (iso) => (rows[iso] ||= { events: [], stu: [], tea: [] });
  if (state.show.events) {
    state.events.forEach(e => {
      if ((e.endDate || e.date) < monthStart || e.date > monthEnd) return;
      row(e.date < monthStart ? monthStart : e.date).events.push(e); // 여러 날 일정은 시작일(이번 달 이전에 시작했으면 1일)에 한 번만 표시
    });
  }
  for (let d = 1; d <= last; d++) {
    const iso = isoOf(year, month, d);
    const bd = birthdaysOn(iso);
    if (state.show.student && bd.students.length) row(iso).stu = bd.students;
    if (state.show.teacher && bd.teachers.length) row(iso).tea = bd.teachers;
  }
  const dates = Object.keys(rows).sort();
  const total = dates.reduce((n, iso) => n + rows[iso].events.length + rows[iso].stu.length + rows[iso].tea.length, 0);
  const today = todayISO();
  const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

  el.innerHTML = `
    <div class="cal-side-head"><h3>🗓️ ${month + 1}월 전체 일정</h3><span class="dim-note">${total}건</span></div>
    ${dates.length ? dates.map(iso => {
      const r = rows[iso];
      const dow = dowOf(iso);
      const evHtml = r.events.map(e => {
        const t = EVENT_TYPES[e.type] || EVENT_TYPES.etc;
        const range = e.endDate && e.endDate !== e.date ? ` · ${md(e.date)} ~ ${md(e.endDate)}` : "";
        return `<div class="cal-mev" style="--c:${t.color}"><span class="cal-mev-title">${escapeHtml(e.title)}</span><span class="cal-mev-sub">${t.label}${range}${e.note ? ` · ${escapeHtml(e.note)}` : ""}</span></div>`;
      }).join("");
      const stuHtml = r.stu.length ? `<div class="cal-mbd">🎂 ${r.stu.map(x => escapeHtml(x.name)).join(", ")} <span class="dim-note">학생</span></div>` : "";
      const teaHtml = r.tea.length ? `<div class="cal-mbd cal-mbd-t">🎂 ${r.tea.map(x => escapeHtml(x.name)).join(", ")} <span class="dim-note">교사</span></div>` : "";
      return `<div class="cal-mrow${iso === today ? " today" : ""}${iso === state.selected ? " sel" : ""}" data-date="${iso}" role="button" tabindex="0">
        <div class="cal-mdate ${dow === 0 ? "sun" : dow === 6 ? "sat" : ""}"><b>${Number(iso.slice(8, 10))}</b><span>${WEEKDAYS[dow]}</span></div>
        <div class="cal-mitems">${evHtml}${stuHtml}${teaHtml}</div>
      </div>`;
    }).join("") : `<p class="dim-note" style="margin:6px 0 0;">이번 달에 표시할 일정이 없습니다.</p>`}`;
}

function renderUpcoming() {
  const el = $("#calUpcoming");
  if (!el) return;
  const today = todayISO();
  const d = new Date(); d.setDate(d.getDate() + 30);
  const end = isoOf(d.getFullYear(), d.getMonth(), d.getDate());
  const list = state.events
    .filter(e => (e.endDate || e.date) >= today && e.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, 8);
  el.innerHTML = `
    <div class="cal-side-head"><h3>📌 다가오는 일정 <span class="dim-note">(30일 이내)</span></h3></div>
    ${list.length ? list.map(e => itemRowEvent(e, true)).join("") : `<p class="dim-note" style="margin:6px 0 0;">다가오는 일정이 없습니다.</p>`}`;
}

function select(iso) {
  state.selected = iso;
  const [y, m] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1];
  if (y !== state.year || m !== state.month) { goMonth(y, m); return; }
  $all(".cal-cell").forEach(c => c.classList.toggle("sel", c.dataset.date === iso));
  $all(".cal-mrow").forEach(r => r.classList.toggle("sel", r.dataset.date === iso));
  renderDetail();
  bindDetail();
  if (window.matchMedia("(max-width: 800px)").matches) {
    $("#calDetail")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

async function goMonth(y, m) {
  const date = new Date(y, m, 1);
  state.year = date.getFullYear();
  state.month = date.getMonth();
  if (state.eventsYear !== null && Math.abs(state.year - state.eventsYear) > 0) {
    // 일정은 기준 연도 ±1년 범위를 불러와 두므로, 범위를 벗어날 때만 다시 조회
    if (state.year < state.eventsYear - 1 || state.year > state.eventsYear + 1) await loadEvents(state.year, true);
  }
  render();
}

function bindDetail() {
  $("#calAddHere")?.addEventListener("click", () => openEventModal(null, state.selected));
  $all(".cal-edit").forEach(b => b.addEventListener("click", () => {
    const ev = state.events.find(e => e.id === b.dataset.id);
    if (ev) openEventModal(ev);
  }));
}

function bindCalendar() {
  $("#calPrev").onclick = () => goMonth(state.year, state.month - 1);
  $("#calNext").onclick = () => goMonth(state.year, state.month + 1);
  $("#calToday").onclick = () => {
    const now = new Date();
    state.selected = todayISO();
    goMonth(now.getFullYear(), now.getMonth());
  };
  $("#calAdd").onclick = () => openEventModal(null, state.selected);
  $all(".cal-toggle").forEach(b => b.onclick = () => {
    state.show[b.dataset.key] = !state.show[b.dataset.key];
    savePrefs();
    render();
  });
  $all(".cal-cell").forEach(c => {
    c.onclick = () => select(c.dataset.date);
    c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(c.dataset.date); } };
  });
  $all(".cal-mrow").forEach(r => {
    r.onclick = () => select(r.dataset.date);
    r.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(r.dataset.date); } };
  });
  bindDetail();
}

// ---------------------------------------------------------------------------
// 일정 추가/수정/삭제 팝업
// ---------------------------------------------------------------------------
function openEventModal(ev, defaultDate) {
  const isEdit = !!ev;
  const date = ev ? ev.date : (defaultDate || todayISO());
  openModal(`
    <h3>${isEdit ? "일정 수정" : "일정 추가"}</h3>
    <label for="ev_title">제목</label>
    <input id="ev_title" maxlength="40" placeholder="예: 청소년부 수련회" value="${escapeHtml(ev?.title || "")}" />
    <label for="ev_type">구분</label>
    <select id="ev_type">${Object.entries(EVENT_TYPES).map(([k, t]) => `<option value="${k}" ${(ev?.type || "youth") === k ? "selected" : ""}>${t.label}</option>`).join("")}</select>
    <label for="ev_date">날짜</label>
    <input type="date" id="ev_date" value="${date}" />
    <label for="ev_end">종료일 <span class="dim-note">(여러 날 일정일 때만)</span></label>
    <input type="date" id="ev_end" value="${ev?.endDate || ""}" />
    <label for="ev_note">메모 <span class="dim-note">(선택)</span></label>
    <textarea id="ev_note" rows="3" maxlength="200">${escapeHtml(ev?.note || "")}</textarea>
    <p id="ev_err" class="error-text"></p>
    <div class="modal-actions">
      ${isEdit ? `<button type="button" id="ev_del" class="btn btn-danger" style="margin-right:auto;">삭제</button>` : ""}
      <button type="button" id="ev_cancel" class="btn">취소</button>
      <button type="button" id="ev_save" class="btn btn-primary">저장</button>
    </div>
  `);
  $("#ev_cancel").onclick = closeModal;
  $("#ev_title").focus();

  $("#ev_save").onclick = async () => {
    const title = $("#ev_title").value.trim();
    const d = $("#ev_date").value;
    let end = $("#ev_end").value;
    const err = $("#ev_err");
    if (!title) { err.textContent = "제목을 입력해주세요."; return; }
    if (!d) { err.textContent = "날짜를 선택해주세요."; return; }
    if (end && end < d) { err.textContent = "종료일은 시작 날짜보다 빠를 수 없습니다."; return; }
    if (end === d) end = "";
    const data = { title, type: $("#ev_type").value, date: d, endDate: end, note: $("#ev_note").value.trim() };
    $("#ev_save").disabled = true;
    try {
      if (isEdit) {
        await updateDoc(doc(db, "events", ev.id), { ...data, updatedBy: currentUser.uid });
      } else {
        await addDoc(collection(db, "events"), { ...data, createdBy: currentUser.uid, createdByName: currentUser.name || "", createdAt: serverTimestamp() });
      }
      closeModal();
      state.selected = d;
      state.year = Number(d.slice(0, 4));
      state.month = Number(d.slice(5, 7)) - 1;
      await loadEvents(state.year, true);
      render();
    } catch (e) {
      console.error("일정 저장 실패", e);
      $("#ev_save").disabled = false;
      err.textContent = (e && e.code === "permission-denied")
        ? "저장 권한이 없습니다. Firebase 규칙에 events 컬렉션 설정이 필요합니다(관리자에게 문의)."
        : "저장하지 못했습니다. 잠시 후 다시 시도해주세요.";
    }
  };

  if (isEdit) {
    $("#ev_del").onclick = async () => {
      if (!confirm(`"${ev.title}" 일정을 삭제할까요?`)) return;
      try {
        await deleteDoc(doc(db, "events", ev.id));
        closeModal();
        await loadEvents(state.year, true);
        render();
      } catch (e) {
        console.error("일정 삭제 실패", e);
        $("#ev_err").textContent = "삭제하지 못했습니다. 잠시 후 다시 시도해주세요.";
      }
    };
  }
}
