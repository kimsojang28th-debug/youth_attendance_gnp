import { db, collection, getDocs, query, where } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { getSundaysOfYear, fmtMonthDay, friendlyFirestoreError } from "./utils.js";

// dataviz 스킬의 검증된 팔레트(blue, sequential) 사용 — 단일 시리즈 차트이므로
// 카테고리컬 다색 대신 하나의 색으로 일관되게 표현합니다.
const COLOR_PRIMARY = "#2a78d6";
const COLOR_PRIMARY_SOFT = "#9ec5f4";
const COLOR_GRID = "#e1e0d9";
const COLOR_AXIS_TEXT = "#898781";
const COLOR_INK = "#0b0b0b";

let charts = {};

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); charts[key] = null; }
}

const baseOptions = {
  responsive: true,
  plugins: {
    legend: { display: false }, // 단일 시리즈이므로 범례 불필요 (제목이 시리즈를 명명)
    tooltip: {
      backgroundColor: "#ffffff",
      titleColor: COLOR_INK,
      bodyColor: COLOR_INK,
      borderColor: COLOR_GRID,
      borderWidth: 1,
      padding: 10
    }
  },
  scales: {
    x: { grid: { color: COLOR_GRID, display: false }, ticks: { color: COLOR_AXIS_TEXT } },
    y: { grid: { color: COLOR_GRID }, ticks: { color: COLOR_AXIS_TEXT }, beginAtZero: true }
  }
};

export async function initStatsView() {
  if (typeof Chart === "undefined") {
    document.querySelectorAll("#view-stats canvas").forEach(c => {
      const msg = document.createElement("p");
      msg.style.cssText = "color:#868e96;font-size:13px;";
      msg.textContent = "차트 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인 후 새로고침해주세요.";
      c.replaceWith(msg);
    });
    return;
  }

  await loadClasses();
  await loadStudents();

  const classes = getClassesCache();
  const students = getStudentsCache().filter(s => s.status === "active" || s.status === "new");
  const year = new Date().getFullYear();
  const sundays = getSundaysOfYear(year);

  // 전체 출석 데이터 한 번에 로드 (해당 연도)
  let snap;
  try {
    snap = await getDocs(query(collection(db, "attendance"), where("date", ">=", `${year}-01-01`), where("date", "<=", `${year}-12-31`)));
  } catch (err) {
    console.error("통계 데이터 조회 실패", err);
    document.querySelectorAll("#view-stats canvas").forEach(c => {
      const msg = document.createElement("p");
      msg.style.cssText = "color:#e03131;font-size:13px;line-height:1.6;";
      msg.innerHTML = friendlyFirestoreError(err);
      c.replaceWith(msg);
    });
    return;
  }
  const attDocs = snap.docs.map(d => d.data());

  renderByClassChart(classes, students, attDocs);
  renderByGradeChart(classes, students, attDocs);
  renderByMonthChart(sundays, students, attDocs);
}

function renderByClassChart(classes, students, attDocs) {
  const labels = [];
  const rates = [];
  for (const c of classes) {
    const classStudents = students.filter(s => s.classId === c.id);
    if (!classStudents.length) continue;
    const classAttDocs = attDocs.filter(a => a.classId === c.id);
    let totalSlots = 0, totalPresent = 0;
    classAttDocs.forEach(a => {
      classStudents.forEach(s => {
        totalSlots++;
        if (a.records?.[s.id] === "O") totalPresent++;
      });
    });
    labels.push(c.name);
    rates.push(totalSlots ? Math.round((totalPresent / totalSlots) * 1000) / 10 : 0);
  }

  destroyChart("byClass");
  const ctx = document.getElementById("chartByClass");
  charts.byClass = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ label: "출석률(%)", data: rates, backgroundColor: COLOR_PRIMARY, borderRadius: 4, maxBarThickness: 36 }] },
    options: { ...baseOptions, scales: { ...baseOptions.scales, y: { ...baseOptions.scales.y, max: 100 } } }
  });
}

function renderByGradeChart(classes, students, attDocs) {
  const gradeOrder = [];
  const gradeMap = {};
  classes.forEach(c => {
    if (!gradeMap[c.grade]) { gradeMap[c.grade] = []; gradeOrder.push(c.grade); }
    gradeMap[c.grade].push(c.id);
  });

  const labels = [];
  const rates = [];
  for (const grade of gradeOrder) {
    const classIds = gradeMap[grade];
    const gradeStudents = students.filter(s => classIds.includes(s.classId));
    if (!gradeStudents.length) continue;
    const gradeAttDocs = attDocs.filter(a => classIds.includes(a.classId));
    let totalSlots = 0, totalPresent = 0;
    gradeAttDocs.forEach(a => {
      gradeStudents.filter(s => s.classId === a.classId).forEach(s => {
        totalSlots++;
        if (a.records?.[s.id] === "O") totalPresent++;
      });
    });
    labels.push(grade);
    rates.push(totalSlots ? Math.round((totalPresent / totalSlots) * 1000) / 10 : 0);
  }

  destroyChart("byGrade");
  const ctx = document.getElementById("chartByGrade");
  charts.byGrade = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ label: "출석률(%)", data: rates, backgroundColor: COLOR_PRIMARY, borderRadius: 4, maxBarThickness: 36 }] },
    options: { ...baseOptions, scales: { ...baseOptions.scales, y: { ...baseOptions.scales.y, max: 100 } } }
  });
}

function renderByMonthChart(sundays, students, attDocs) {
  const byMonth = {};
  sundays.forEach(date => {
    const month = date.slice(0, 7); // YYYY-MM
    if (!byMonth[month]) byMonth[month] = { slots: 0, present: 0 };
  });

  attDocs.forEach(a => {
    const month = a.date.slice(0, 7);
    if (!byMonth[month]) return;
    const classStudents = students.filter(s => s.classId === a.classId);
    classStudents.forEach(s => {
      byMonth[month].slots++;
      if (a.records?.[s.id] === "O") byMonth[month].present++;
    });
  });

  const months = Object.keys(byMonth).sort();
  const labels = months.map(m => `${Number(m.split("-")[1])}월`);
  const rates = months.map(m => {
    const { slots, present } = byMonth[m];
    return slots ? Math.round((present / slots) * 1000) / 10 : null;
  });

  destroyChart("byMonth");
  const ctx = document.getElementById("chartByMonth");
  charts.byMonth = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "전체 출석률(%)", data: rates,
        borderColor: COLOR_PRIMARY, backgroundColor: COLOR_PRIMARY_SOFT,
        borderWidth: 2, pointRadius: 3, pointBackgroundColor: COLOR_PRIMARY,
        tension: 0.25, spanGaps: true, fill: false
      }]
    },
    options: { ...baseOptions, scales: { ...baseOptions.scales, y: { ...baseOptions.scales.y, max: 100 } } }
  });
}
