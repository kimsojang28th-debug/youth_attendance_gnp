import { db, collection, getDocs, query, where } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache, openStudentProfileModal, studentThumbHtml } from "./students.js";
import {
  $, escapeHtml, getSundaysOfYear, fmtMonthDay, sortByName, friendlyFirestoreError,
  openModal, closeModal, nearestSundayISO
} from "./utils.js";

// "연간출석부" 화면 (2026-10-24 개편): 반을 하나씩 고르던 방식에서, 전체 반을 한 표에 반별 구역으로 쭉 보여주는
// 방식으로 바꿈. 교사 계정도 구분 없이 전체 반을 볼 수 있음(합반/대체 교사 투입이 잦기 때문).
// - 반 헤더 줄 → 학생 줄들 → 반 소계 줄 이 반복되고, 맨 아래에 전체 합계(새친구반 제외)가 있음
// - 맨 위 월 구분줄, 이름 열/헤더 고정, 이번 주 열 강조, "기록 없는 주일 숨기기", 학생별 출석률, 반 접기/펼치기, CSV 저장

// 학생 프로필 화면의 "출석현황" 버튼처럼, 다른 화면에서 "이 반을 보여달라"고 미리 요청해둘 수 있게 하는 값.
// initAnnualView가 다음에 실행될 때 한 번만 사용되고 초기화됨(전체 표를 보여주되 그 반 구역으로 자동 이동).
let _pendingClassId = null;
export function requestAnnualClass(classId) {
  _pendingClassId = classId;
}

let _model = null;            // 현재 화면의 표 데이터 (CSV 저장에도 같은 데이터를 사용)
let _focusClassId = null;     // 렌더 후 자동으로 스크롤해서 보여줄 반
const _collapsed = new Set(); // 접어둔 반 id (화면을 다시 그려도 유지)

export async function initAnnualView() {
  const classes = await loadClasses();
  await loadStudents();

  const yearSelect = $("#annualYearSelect");
  const thisYear = new Date().getFullYear();
  yearSelect.innerHTML = [thisYear, thisYear - 1, thisYear + 1]
    .map(y => `<option value="${y}" ${y === thisYear ? "selected" : ""}>${y}년</option>`).join("");

  const classSelect = $("#annualClassSelect");
  classSelect.innerHTML = `<option value="all">전체 반</option>` +
    classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  classSelect.value = "all";

  _focusClassId = (_pendingClassId && classes.some(c => c.id === _pendingClassId)) ? _pendingClassId : null;
  _pendingClassId = null;

  yearSelect.onchange = renderAnnualTable;
  classSelect.onchange = renderAnnualTable;
  $("#annualHideEmpty").onchange = renderAnnualTable;
  $("#annualCsvBtn").onclick = exportCsv;

  await renderAnnualTable();
}

function rateText(present, eligible) {
  return eligible ? `${Math.round((present / eligible) * 1000) / 10}%` : "-";
}

async function renderAnnualTable() {
  const year = Number($("#annualYearSelect").value);
  const sel = $("#annualClassSelect").value || "all";
  const hideEmpty = $("#annualHideEmpty").checked;
  const wrap = $("#annualTableWrap");
  wrap.innerHTML = `<p style="padding:16px;color:#868e96;">불러오는 중...</p>`;

  const classes = getClassesCache().filter(c => sel === "all" || c.id === sel);

  // 반마다 따로 조회하지 않고, 그 해의 출석 기록을 날짜 범위로 한 번에 가져옴(날짜 하나에 대한 범위 조회라 별도 색인 불필요)
  let snap;
  try {
    snap = await getDocs(query(
      collection(db, "attendance"),
      where("date", ">=", `${year}-01-01`),
      where("date", "<=", `${year}-12-31`)
    ));
  } catch (err) {
    console.error("연간출석부 조회 실패", err);
    wrap.innerHTML = `<p class="list empty" style="padding:16px;line-height:1.6;color:#e03131;">${friendlyFirestoreError(err)}</p>`;
    return;
  }
  const docsByClass = {}; // docsByClass[classId][date] = { records, notes }
  snap.docs.forEach(d => {
    const x = d.data();
    (docsByClass[x.classId] ||= {})[x.date] = { records: x.records || {}, notes: x.notes || {} };
  });

  // 보여줄 주일: 기본은 그 해의 모든 주일, "기록 없는 주일 숨기기"를 켜면 출석 기록이 하나라도 있는 주일만
  const recordedDates = new Set();
  classes.forEach(c => Object.keys(docsByClass[c.id] || {}).forEach(d => recordedDates.add(d)));
  const allSundays = getSundaysOfYear(year);
  const sundays = hideEmpty ? allSundays.filter(d => recordedDates.has(d)) : allSundays;
  if (!sundays.length) {
    wrap.innerHTML = `<p class="list empty" style="padding:16px;">이 해에는 출석 기록이 있는 주일이 아직 없습니다.</p>`;
    _model = null;
    return;
  }

  // "제적"/"졸업" 학생은 청소년부 출석부에서 제외(졸업은 청년부로 넘어간 것)
  const students = getStudentsCache().filter(s => s.status !== "removed" && s.status !== "graduated");

  const sections = classes.map(c => {
    const list = sortByName(students.filter(s => s.classId === c.id));
    const rows = list.map(s => {
      let present = 0, eligible = 0;
      const cells = sundays.map(date => {
        const d = docsByClass[c.id]?.[date];
        // 등록일(joinDate) 이전 주일, 또는 그 주 출석 기록 자체가 없는 주일은 "-"(해당없음).
        // 기록은 있는데 이 학생 값만 없으면 결석(X)으로 간주.
        if (!d || (s.joinDate && date < s.joinDate)) return { val: null, note: "" };
        const val = d.records[s.id] === "O" ? "O" : "X";
        eligible++;
        if (val === "O") present++;
        return { val, note: d.notes[s.id] || "" };
      });
      return { s, cells, present, eligible };
    });
    const weekly = sundays.map((_, i) => rows.filter(r => r.cells[i].val === "O").length);
    return {
      cls: c, rows, weekly,
      totalPresent: rows.reduce((a, r) => a + r.present, 0),
      totalEligible: rows.reduce((a, r) => a + r.eligible, 0)
    };
  });

  // 전체 합계는 대시보드와 같은 기준으로 새친구반을 제외하고 계산(전체 반을 볼 때만 표시)
  let grand = null;
  if (sel === "all") {
    const regular = sections.filter(sec => sec.cls.id !== "newcomer");
    grand = {
      weekly: sundays.map((_, i) => regular.reduce((a, sec) => a + sec.weekly[i], 0)),
      totalPresent: regular.reduce((a, sec) => a + sec.totalPresent, 0),
      totalEligible: regular.reduce((a, sec) => a + sec.totalEligible, 0)
    };
  }
  _model = { year, sundays, sections, grand };

  const thisSunday = nearestSundayISO();
  const wk = (date) => date === thisSunday ? " annual-this-week" : "";
  const N = sundays.length;

  // 월 구분줄: 같은 달의 주일끼리 묶음
  const months = [];
  sundays.forEach(d => {
    const m = Number(d.split("-")[1]);
    const last = months[months.length - 1];
    if (last && last.month === m) last.count++; else months.push({ month: m, count: 1 });
  });

  const teacherLine = (c) => (c.teacherNames && c.teacherNames.length) ? `담당 ${escapeHtml(c.teacherNames.join(", "))}` : "담당 미배정";

  const bodyHtml = sections.map(sec => {
    const { cls } = sec;
    // 반 헤더는 표 전체 폭을 쓰고, 글자만 화면 왼쪽에 붙어 따라오게 함(이름 열 폭을 늘리지 않기 위해)
    const header = `
      <tr class="annual-class-row" data-class-id="${cls.id}">
        <td colspan="${N + 3}"><span class="annual-class-label"><span class="annual-caret">${_collapsed.has(cls.id) ? "▸" : "▾"}</span> <b>${escapeHtml(cls.name)}</b>
          <span class="dim-note">${teacherLine(cls)} · ${sec.rows.length}명</span></span></td>
      </tr>`;
    if (!sec.rows.length) {
      return header + `<tr class="annual-student-row" data-class-id="${cls.id}"><td colspan="${N + 3}" class="dim-note annual-empty-note">이 반에 등록된 학생이 없습니다.</td></tr>`;
    }
    const rowsHtml = sec.rows.map(r => {
      const cells = r.cells.map((c, i) => {
        const hasNote = !!(c.note && c.note.trim());
        const cls2 = c.val === "O" ? "att-o" : c.val === "X" ? "att-x" : "";
        return `<td class="att-cell ${cls2}${hasNote ? " att-has-note" : ""}${wk(sundays[i])}" style="cursor:${hasNote ? "pointer" : "default"};" data-date="${sundays[i]}" ${hasNote ? `data-note="${escapeHtml(c.note)}"` : ""}>${c.val || "-"}</td>`;
      }).join("");
      return `<tr class="annual-student-row" data-class-id="${cls.id}">
        <td><span class="student-name-cell">${studentThumbHtml(r.s)}<a href="#" class="student-name-link" data-student-id="${r.s.id}">${escapeHtml(r.s.name)}</a></span></td>
        ${cells}<td class="annual-sum">${r.present}</td><td class="annual-rate">${rateText(r.present, r.eligible)}</td></tr>`;
    }).join("");
    const subtotal = `<tr class="annual-subtotal-row" data-class-id="${cls.id}">
        <td>소계</td>
        ${sec.weekly.map((n, i) => `<td class="${wk(sundays[i]).trim()}">${n}</td>`).join("")}
        <td class="annual-sum">${sec.totalPresent}</td><td class="annual-rate">${rateText(sec.totalPresent, sec.totalEligible)}</td></tr>`;
    return header + rowsHtml + subtotal;
  }).join("");

  const grandHtml = grand ? `
    <tr class="annual-grand-row">
      <td>전체 합계</td>
      ${grand.weekly.map((n, i) => `<td class="${wk(sundays[i]).trim()}">${n}</td>`).join("")}
      <td class="annual-sum">${grand.totalPresent}</td><td class="annual-rate">${rateText(grand.totalPresent, grand.totalEligible)}</td>
    </tr>` : "";

  wrap.innerHTML = `
    <table class="annual-table">
      <thead>
        <tr class="annual-month-row"><th rowspan="2">이름</th>${months.map(m => `<th colspan="${m.count}">${m.month}월</th>`).join("")}<th rowspan="2">합계</th><th rowspan="2">출석률</th></tr>
        <tr class="annual-date-row">${sundays.map(d => `<th class="${wk(d).trim()}">${fmtMonthDay(d)}</th>`).join("")}</tr>
      </thead>
      <tbody>${bodyHtml}</tbody>
      ${grand ? `<tfoot>${grandHtml}</tfoot>` : ""}
    </table>
  `;

  applyCollapse(wrap);

  // 반 헤더 줄을 누르면 그 반 학생 줄을 접거나 펼침
  wrap.querySelectorAll(".annual-class-row").forEach(row => {
    row.onclick = () => {
      const id = row.dataset.classId;
      if (_collapsed.has(id)) _collapsed.delete(id); else _collapsed.add(id);
      applyCollapse(wrap);
    };
  });

  wrap.querySelectorAll(".att-has-note").forEach(cell => {
    cell.onclick = () => {
      const tr = cell.closest("tr");
      const studentName = tr.querySelector("td:first-child").textContent.trim();
      const date = cell.dataset.date;
      const note = cell.dataset.note || "";
      openModal(`
        <h3>출결 특이사항</h3>
        <p style="font-size:13px;color:#6b7280;margin:0 0 10px;">${escapeHtml(studentName)} · ${escapeHtml(date)}</p>
        <p style="white-space:pre-wrap;line-height:1.6;">${escapeHtml(note)}</p>
        <div class="modal-actions">
          <button id="cancelBtn" class="btn">닫기</button>
        </div>
      `);
      $("#cancelBtn").onclick = closeModal;
    };
  });

  // 이름을 누르면 재적부와 동일한 학생 프로필 모달(사진/연락처/보호자 등)이 뜸
  wrap.querySelectorAll(".student-name-link").forEach(link => {
    link.onclick = (e) => {
      e.preventDefault();
      const id = e.currentTarget.dataset.studentId;
      const student = getStudentsCache().find(s => s.id === id);
      if (student) openStudentProfileModal(student);
    };
  });

  // 열었을 때 이번 주 열이 보이도록 가로 스크롤, 특정 반을 요청받았으면 그 반 구역으로 세로 스크롤
  requestAnimationFrame(() => {
    const wrapRect = wrap.getBoundingClientRect();
    const thisTh = wrap.querySelector(".annual-date-row th.annual-this-week");
    if (thisTh) {
      wrap.scrollLeft = Math.max(0, thisTh.getBoundingClientRect().left - wrapRect.left + wrap.scrollLeft - 260);
    }
    if (_focusClassId) {
      const row = wrap.querySelector(`.annual-class-row[data-class-id="${_focusClassId}"]`);
      if (row) wrap.scrollTop = Math.max(0, row.getBoundingClientRect().top - wrapRect.top + wrap.scrollTop - 72);
      _focusClassId = null;
    }
  });
}

function applyCollapse(wrap) {
  wrap.querySelectorAll(".annual-student-row").forEach(tr => {
    tr.classList.toggle("hidden", _collapsed.has(tr.dataset.classId));
  });
  wrap.querySelectorAll(".annual-class-row").forEach(tr => {
    const caret = tr.querySelector(".annual-caret");
    if (caret) caret.textContent = _collapsed.has(tr.dataset.classId) ? "▸" : "▾";
  });
}

// 지금 화면에 보이는 표(연도/반/주일 숨김 설정 그대로)를 엑셀에서 바로 열리는 CSV로 저장
function exportCsv() {
  if (!_model) return;
  const { year, sundays, sections, grand } = _model;
  const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = [];
  lines.push(["반", "이름", ...sundays.map(fmtMonthDay), "합계", "출석률"].map(esc).join(","));
  sections.forEach(sec => {
    sec.rows.forEach(r => {
      lines.push([sec.cls.name, r.s.name, ...r.cells.map(c => c.val || "-"), r.present, rateText(r.present, r.eligible)].map(esc).join(","));
    });
    if (sec.rows.length) {
      lines.push([sec.cls.name, "반 소계", ...sec.weekly, sec.totalPresent, rateText(sec.totalPresent, sec.totalEligible)].map(esc).join(","));
    }
  });
  if (grand) {
    lines.push(["전체", "전체 합계(새친구반 제외)", ...grand.weekly, grand.totalPresent, rateText(grand.totalPresent, grand.totalEligible)].map(esc).join(","));
  }
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `연간출석부_${year}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
