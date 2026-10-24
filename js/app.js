import { initAuth, isAdmin } from "./auth.js";
import { seedDefaultClassesIfEmpty, initClassesView } from "./classes.js";
import { $, $all } from "./utils.js";
import { initDashboardView } from "./dashboard.js";
import { initAttendanceView } from "./attendance.js";
import { initStudentsView } from "./students.js";
import { initReportView } from "./report.js";
import { initWorshipView } from "./worship.js";
import { initAnnualView } from "./annual.js";
import { initStatsView } from "./stats.js";
import { initHistoryView } from "./history.js";
import { initImportView } from "./import.js";
import { initBirthdaysView } from "./birthdays.js";
import { initYearlyPlanView } from "./yearlyplan.js";
import { initTeachersView } from "./teachers.js";

const viewInitializers = {
  dashboard: initDashboardView,
  attendance: initAttendanceView,
  students: initStudentsView,
  classes: initClassesView,
  worship: initWorshipView,
  report: initReportView,
  annual: initAnnualView,
  stats: initStatsView,
  history: initHistoryView,
  import: initImportView,
  birthdays: initBirthdaysView,
  yearlyplan: initYearlyPlanView,
  teachers: initTeachersView
};

// ---------------------------------------------------------------------------
// 메뉴 구성 (2026-10-24 개편): 13개 메뉴를 "무엇을 하러 왔는가" 기준 5개 그룹으로 정리.
//   홈      : 대시보드
//   입력    : 매주 직접 입력하는 화면 (출석체크, 예배정보입력)
//   조회    : 입력한 결과를 보는 화면 (주간보고서, 연간출석부, 월별 생일자, 통계, 재적변동이력)
//   인원    : 명단 관리 (재적부, 교사현황)
//   운영    : 연 1~2회 손보는 설정성 항목 (연간계획, 반 관리)
// "출석 가져오기(import)"는 현재 쓰지 않아 메뉴에서만 뺐고, 화면/코드는 남겨둠(주소 #import 로는 열림).
// PC 상단 드롭다운, 모바일 하단 탭바, 현재 위치(브레드크럼)가 모두 이 설정 하나에서 만들어진다.
// ---------------------------------------------------------------------------
const MENU = [
  { id: "home", icon: "🏠", label: "홈", views: [["dashboard", "대시보드", "🏠"]] },
  { id: "input", icon: "✏️", label: "입력", views: [["attendance", "출석체크", "✅"], ["worship", "예배정보입력", "🎵"]] },
  { id: "view", icon: "📄", label: "조회", views: [
    ["report", "주간보고서", "📝"], ["annual", "연간출석부", "📅"], ["birthdays", "월별 생일자", "🎂"],
    ["stats", "통계", "📊"], ["history", "재적변동이력", "🔄"]
  ] },
  { id: "people", icon: "👥", label: "인원", views: [["students", "재적부", "📋"], ["teachers", "교사현황", "🧑‍🏫"]] },
  { id: "admin", icon: "⚙️", label: "운영", views: [["yearlyplan", "연간계획", "🗓️"], ["classes", "반 관리", "🗂️"]] }
];

const VIEW_META = {};
MENU.forEach(g => g.views.forEach(([id, label, icon]) => { VIEW_META[id] = { group: g, label, icon }; }));

let currentView = null;

function viewFromHash() {
  const v = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  return viewInitializers[v] ? v : null;
}

export async function showView(name) {
  if (!viewInitializers[name]) name = "dashboard";
  currentView = name;
  // 화면마다 주소(#attendance 등)를 붙여서 뒤로가기/새로고침/즐겨찾기가 정상 동작하도록 함
  if (location.hash !== "#" + name) location.hash = name;

  closeMenus();
  $all(".view").forEach(v => v.classList.add("hidden"));
  updateNavState(name);
  const section = $(`#view-${name}`);
  section.classList.remove("hidden");
  window.scrollTo(0, 0);
  try {
    await viewInitializers[name]?.();
  } catch (err) {
    console.error(`${name} 화면 로딩 실패`, err);
  }
}

function itemLink(id, label, icon, cls) {
  return `<a href="#${id}" class="${cls}" data-view="${id}"><span class="item-icon">${icon}</span><span>${label}</span></a>`;
}

function renderMenus() {
  // PC: 상단 그룹 메뉴(드롭다운)
  $("#mainNav").innerHTML = MENU.map(g => {
    if (g.id === "home") {
      return `<a href="#dashboard" class="nav-group-btn" data-group="home" data-view="dashboard">${g.icon} ${g.label}</a>`;
    }
    return `
      <div class="nav-group" data-group="${g.id}">
        <button type="button" class="nav-group-btn" data-group="${g.id}" aria-haspopup="true" aria-expanded="false">${g.icon} ${g.label} <span class="caret">▾</span></button>
        <div class="nav-dropdown"><div class="nav-dropdown-inner">
          ${g.views.map(([id, label, icon]) => itemLink(id, label, icon, "nav-item")).join("")}
        </div></div>
      </div>`;
  }).join("");

  // 모바일: 하단 탭바
  $("#tabbar").innerHTML = MENU.map(g => `
    <button type="button" class="tab" data-group="${g.id}">
      <span class="tab-icon">${g.icon}</span><span class="tab-label">${g.label}</span>
    </button>`).join("");
}

function updateNavState(name) {
  const meta = VIEW_META[name];
  const groupId = meta ? meta.group.id : null;
  $all(".nav-group-btn, .tab").forEach(b => b.classList.toggle("active", b.dataset.group === groupId));
  $all(".nav-item, .sheet-item").forEach(a => a.classList.toggle("active", a.dataset.view === name));

  // 현재 위치 표시 (대시보드는 표시하지 않음)
  const crumb = $("#breadcrumb");
  if (!meta) crumb.textContent = name === "import" ? "출석 가져오기" : "";
  else if (name === "dashboard") crumb.textContent = "";
  else crumb.textContent = `${meta.group.label} › ${meta.label}`;
}

function closeMenus() {
  $all(".nav-group.open").forEach(g => {
    g.classList.remove("open");
    g.querySelector(".nav-group-btn")?.setAttribute("aria-expanded", "false");
  });
  closeSheet();
}

// ----- 모바일 하단 시트 (탭을 누르면 그 그룹의 하위 메뉴가 아래에서 올라옴) -----
let openSheetGroup = null;
function openSheet(group) {
  openSheetGroup = group.id;
  $("#sheetTitle").textContent = `${group.icon} ${group.label}`;
  $("#sheetItems").innerHTML = group.views.map(([id, label, icon]) => itemLink(id, label, icon, "sheet-item")).join("");
  updateNavState(currentView);
  $("#groupSheet").classList.remove("hidden");
  $all(".tab").forEach(t => t.classList.toggle("sheet-open", t.dataset.group === group.id));
}
function closeSheet() {
  openSheetGroup = null;
  $("#groupSheet").classList.add("hidden");
  $all(".tab").forEach(t => t.classList.remove("sheet-open"));
}

// 이미 보고 있는 화면의 링크를 다시 누르면 hashchange가 일어나지 않으므로, 직접 새로고침 처리
function refreshIfSame(e) {
  const a = e.target.closest("a[data-view]");
  if (!a) return;
  closeMenus();
  if (a.dataset.view === currentView) { e.preventDefault(); showView(currentView); }
}

function setupNav() {
  renderMenus();

  // PC 드롭다운: 마우스를 올리면 열리고(CSS), 눌러도 열고 닫힘(터치/키보드용)
  $("#mainNav").addEventListener("click", (e) => {
    const btn = e.target.closest("button.nav-group-btn");
    if (btn) {
      const group = btn.closest(".nav-group");
      const willOpen = !group.classList.contains("open");
      closeMenus();
      group.classList.toggle("open", willOpen);
      btn.setAttribute("aria-expanded", String(willOpen));
      return;
    }
    const item = e.target.closest(".nav-item");
    if (item) {
      const g = item.closest(".nav-group");
      g.classList.add("closing");
      g.addEventListener("mouseleave", () => g.classList.remove("closing"), { once: true });
    }
    refreshIfSame(e);
  });
  $("#brandLink").addEventListener("click", refreshIfSame); // 타이틀 클릭 → 메인(대시보드)
  document.addEventListener("click", (e) => { if (!e.target.closest(".nav-group")) $all(".nav-group.open").forEach(g => g.classList.remove("open")); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

  // 모바일 탭바
  $("#tabbar").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    const group = MENU.find(g => g.id === tab.dataset.group);
    if (group.id === "home") { closeSheet(); showView("dashboard"); return; }
    if (openSheetGroup === group.id) closeSheet(); else openSheet(group);
  });
  $("#sheetItems").addEventListener("click", refreshIfSame);
  $("#sheetBackdrop").addEventListener("click", closeSheet);

  // 뒤로가기/앞으로가기/주소 직접 변경
  window.addEventListener("hashchange", () => {
    if ($("#app").classList.contains("hidden")) return;
    const v = viewFromHash();
    if (v && v !== currentView) showView(v);
  });
}

// 대시보드의 "이번 주 반별 출석 현황"에서 반 이름을 클릭했을 때, 출석체크 화면으로 이동하면서
// 그 반과 그 주일 날짜를 자동으로 선택해줌.
export async function goToAttendance(classId, date) {
  await showView("attendance");
  const yearSelect = $("#attendanceYearSelect");
  const year = String(new Date(date).getFullYear());
  if (yearSelect.value !== year && yearSelect.querySelector(`option[value="${year}"]`)) {
    yearSelect.value = year;
    yearSelect.dispatchEvent(new Event("change"));
  }
  const dateSelect = $("#attendanceDate");
  if (dateSelect.querySelector(`option[value="${date}"]`)) {
    dateSelect.value = date;
  }
  const classSelect = $("#attendanceClassSelect");
  if (classSelect.querySelector(`option[value="${classId}"]`)) {
    classSelect.value = classId;
  }
  $("#loadAttendanceBtn").click();
}

async function onLogin() {
  $("#loginScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (isAdmin()) {
    try { await seedDefaultClassesIfEmpty(); } catch (err) { console.warn("기본 반 생성 실패:", err); }
  }
  // 주소에 화면 이름이 있으면(새로고침/즐겨찾기) 그 화면으로, 없으면 대시보드로
  showView(viewFromHash() || "dashboard");
}

function onLogout() {
  closeMenus();
  currentView = null;
  $("#app").classList.add("hidden");
  $("#loginScreen").classList.remove("hidden");
  $("#loginEmail").value = "";
  $("#loginPassword").value = "";
}

setupNav();
initAuth({ onLogin, onLogout });
