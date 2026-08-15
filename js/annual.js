import { db, collection, getDocs, query, where } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { $, escapeHtml, getSundaysOfYear, fmtMonthDay, sortByName, friendlyFirestoreError } from "./utils.js";
import { isAdmin, currentUser } from "./auth.js";

export async function initAnnualView() {
  const classes = await loadClasses();
  await loadStudents();
  const visible = isAdmin() ? classes : classes.filter(c => currentUser.classIds.includes(c.id));

  const yearSelect = $("#annualYearSelect");
  const thisYear = new Date().getFullYear();
  yearSelect.innerHTML = [thisYear, thisYear - 1, thisYear + 1]
    .map(y => `<option value="${y}" ${y === thisYear ? "selected" : ""}>${y}년</option>`).join("");

  const classSelect = $("#annualClassSelect");
  classSelect.innerHTML = visible.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  yearSelect.onchange = renderAnnualTable;
  classSelect.onchange = renderAnnualTable;

  if (visible.length) await renderAnnualTable();
}

async function renderAnnualTable() {
  const year = Number($("#annualYearSelect").value);
  const classId = $("#annualClassSelect").value;
  if (!classId) return;

  const wrap = $("#annualTableWrap");
  wrap.innerHTML = `<p style="padding:16px;color:#868e96;">불러오는 중...</p>`;

  const sundays = getSundaysOfYear(year);
  const students = sortByName(getStudentsCache().filter(s => s.classId === classId && s.status !== "removed"));

  const q = query(
    collection(db, "attendance"),
    where("classId", "==", classId),
    where("date", ">=", `${year}-01-01`),
    where("date", "<=", `${year}-12-31`)
  );
  let snap;
  try {
    snap = await getDocs(q);
  } catch (err) {
    console.error("연간출석부 조회 실패", err);
    wrap.innerHTML = `<p class="list empty" style="padding:16px;line-height:1.6;color:#e03131;">${friendlyFirestoreError(err)}</p>`;
    return;
  }
  const byDate = {};
  snap.docs.forEach(d => { byDate[d.data().date] = d.data().records || {}; });

  if (!students.length) {
    wrap.innerHTML = `<p class="list empty" style="padding:16px;">이 반에 등록된 학생이 없습니다.</p>`;
    return;
  }

  const rowsHtml = students.map(s => {
    let total = 0;
    const cells = sundays.map(date => {
      const val = byDate[date]?.[s.id];
      if (val === "O") total++;
      const display = val || "-";
      const cls = val === "O" ? "att-o" : val === "X" ? "att-x" : "";
      return `<td class="att-cell ${cls}" style="cursor:default;">${display}</td>`;
    }).join("");
    return `<tr><td>${escapeHtml(s.name)}</td>${cells}<td style="font-weight:700;">${total}</td></tr>`;
  }).join("");

  const weeklyTotals = sundays.map(date => {
    const records = byDate[date] || {};
    return students.filter(s => records[s.id] === "O").length;
  });
  const grandTotal = weeklyTotals.reduce((a, b) => a + b, 0);

  wrap.innerHTML = `
    <table>
      <thead>
        <tr><th>이름</th>${sundays.map(d => `<th>${fmtMonthDay(d)}</th>`).join("")}<th>합계</th></tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr style="font-weight:700;"><td>주별 합계</td>${weeklyTotals.map(t => `<td>${t}</td>`).join("")}<td>${grandTotal}</td></tr>
      </tfoot>
    </table>
  `;
}
