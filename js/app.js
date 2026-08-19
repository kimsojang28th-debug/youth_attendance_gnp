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
  yearlyplan: initYearlyPlanView
};

async function showView(name) {
  $all(".view").forEach(v => v.classList.add("hidden"));
  $all(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  const section = $(`#view-${name}`);
  section.classList.remove("hidden");
  try {
    await viewInitializers[name]?.();
  } catch (err) {
    console.error(`${name} 화면 로딩 실패`, err);
  }
}

function setupNav() {
  $all(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });
}

async function onLogin() {
  $("#loginScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (isAdmin()) {
    try { await seedDefaultClassesIfEmpty(); } catch (err) { console.warn("기본 반 생성 실패:", err); }
  }
  showView("dashboard");
}

function onLogout() {
  $("#app").classList.add("hidden");
  $("#loginScreen").classList.remove("hidden");
  $("#loginEmail").value = "";
  $("#loginPassword").value = "";
}

setupNav();
initAuth({ onLogin, onLogout });
