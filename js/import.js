import { db, doc, setDoc, serverTimestamp } from "./firebase-init.js";
import { loadClasses, getClassesCache } from "./classes.js";
import { loadStudents, getStudentsCache } from "./students.js";
import { $, escapeHtml, parseDelimitedLine } from "./utils.js";
import { isAdmin } from "./auth.js";
import { attendanceDocId } from "./attendance.js";

// 구글시트 "연간출석부" 형식의 표(헤더에 이름/날짜, 아래 행에 학생별 O/X)를
// 붙여넣기 → 한 번에 여러 주(week)의 출석 기록으로 변환해서 Firestore에 저장합니다.

let parsedPlan = null;

export async function initImportView() {
  const wrap = $("#view-import");

  if (!isAdmin()) {
    wrap.innerHTML = `
      <h2>출석 가져오기</h2>
      <div class="panel"><p class="list empty">이 기능은 관리자(부장)만 사용할 수 있습니다.</p></div>
    `;
    return;
  }

  const classes = await loadClasses();
  await loadStudents();
  parsedPlan = null;

  wrap.innerHTML = `
    <h2>연간출석부 일괄 가져오기</h2>
    <div class="panel">
      <p style="font-size:13.5px;color:#6b7280;line-height:1.6;">
        기존 구글시트의 <b>연간출석부</b> 시트에서, 가져올 반의 데이터를 <b>"이름" 헤더가 있는 줄부터</b>
        마지막 날짜 열까지, 학생 행 전체와 함께 복사해서 아래에 붙여넣으세요. (구글시트에서 셀 범위를
        드래그해서 복사하면 자동으로 탭으로 구분되어 붙여넣기 됩니다. 학년/성별 열이 섞여 있어도 괜찮습니다.)
      </p>
      <p style="font-size:12.5px;color:#868e96;">
        예시 첫 줄: <code>이름&nbsp;&nbsp;학년&nbsp;&nbsp;성별&nbsp;&nbsp;1/4&nbsp;&nbsp;1/11&nbsp;&nbsp;1/18 ...</code>
        (M/D 형식의 날짜만 인식합니다. 뒤에 "합계" 같은 열이 있어도 무시되니 그대로 두셔도 됩니다.)
      </p>

      <label>반 선택</label>
      <select id="importClassSelect">${classes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select>

      <label>연도 (날짜 열의 "1/4" 같은 값에 적용할 연도)</label>
      <select id="importYearSelect">
        ${[2025, 2026, 2027].map(y => `<option value="${y}" ${y === 2026 ? "selected" : ""}>${y}년</option>`).join("")}
      </select>

      <label>붙여넣기</label>
      <textarea id="importAttendanceInput" rows="10" style="width:100%;font-family:monospace;font-size:12.5px;"
        placeholder="이름	학년	성별	1/4	1/11	1/18
정현우	중1	남	O	X	X
안다은	중1	여	O	O	X"></textarea>

      <div style="margin-top:10px;display:flex;gap:8px;">
        <button id="previewImportBtn" class="btn">미리보기</button>
        <button id="runImportBtn" class="btn btn-primary" disabled>가져오기 실행</button>
      </div>
      <div id="importPreview" style="margin-top:14px;font-size:13.5px;"></div>
      <p id="importResultMsg" class="save-msg"></p>
    </div>
  `;

  $("#previewImportBtn").onclick = () => handlePreview();
  $("#runImportBtn").onclick = () => handleRunImport();
}

function handlePreview() {
  const text = $("#importAttendanceInput").value;
  const year = Number($("#importYearSelect").value);
  const classId = $("#importClassSelect").value;
  const result = parseAttendanceBlock(text, year);

  const classStudents = getStudentsCache().filter(s => s.classId === classId);
  const nameToId = Object.fromEntries(classStudents.map(s => [s.name, s.id]));

  const matchedNames = [];
  const unmatchedNames = [];
  result.rows.forEach(r => {
    if (nameToId[r.name]) matchedNames.push(r.name);
    else unmatchedNames.push(r.name);
  });

  parsedPlan = { ...result, classId, nameToId };

  const previewEl = $("#importPreview");
  if (!result.dates.length) {
    previewEl.innerHTML = `<p style="color:#e03131;">날짜 열을 인식하지 못했습니다. 첫 줄에 1/4, 1/11 같은 형식의 날짜가 포함되어 있는지 확인해주세요.</p>`;
    $("#runImportBtn").disabled = true;
    return;
  }
  if (!result.rows.length) {
    previewEl.innerHTML = `<p style="color:#e03131;">학생 행을 인식하지 못했습니다. 붙여넣은 내용을 확인해주세요.</p>`;
    $("#runImportBtn").disabled = true;
    return;
  }

  previewEl.innerHTML = `
    <p>인식된 날짜: <b>${result.dates.length}개</b> (${result.dates[0]} ~ ${result.dates[result.dates.length - 1]})</p>
    <p>인식된 학생 행: <b>${result.rows.length}명</b> / 이 반 재적부와 이름이 일치: <b>${matchedNames.length}명</b></p>
    ${unmatchedNames.length ? `
      <p style="color:#e03131;">
        ⚠️ 이름이 일치하지 않아 건너뛸 학생 (${unmatchedNames.length}명): ${unmatchedNames.map(escapeHtml).join(", ")}<br/>
        <span style="font-size:12px;color:#868e96;">재적부에 먼저 등록하시거나, 이름 철자를 맞춰주세요.</span>
      </p>` : `<p style="color:#2f9e44;">모든 이름이 재적부와 일치합니다. ✅</p>`}
  `;
  $("#runImportBtn").disabled = matchedNames.length === 0;
}

async function handleRunImport() {
  if (!parsedPlan) return;
  const btn = $("#runImportBtn");
  btn.disabled = true;
  const msgEl = $("#importResultMsg");
  msgEl.textContent = "저장 중...";

  let weeksWritten = 0;
  for (const date of parsedPlan.dates) {
    const records = {};
    let hasAnyValue = false;
    for (const row of parsedPlan.rows) {
      const studentId = parsedPlan.nameToId[row.name];
      if (!studentId) continue;
      const val = row.values[date];
      if (val === undefined) continue;
      records[studentId] = val;
      hasAnyValue = true;
    }
    if (!hasAnyValue) continue; // 그 주는 데이터가 전혀 없음(예배 없었던 주 등) -> 건너뜀

    await setDoc(doc(db, "attendance", attendanceDocId(parsedPlan.classId, date)), {
      classId: parsedPlan.classId,
      date,
      records,
      checkedBy: "bulk-import",
      checkedAt: serverTimestamp()
    });
    weeksWritten++;
  }

  msgEl.textContent = `완료되었습니다. ${weeksWritten}개 주(week)의 출석 데이터를 저장했습니다.`;
  btn.disabled = false;
}

// 붙여넣은 텍스트(탭 또는 쉼표 구분)를 { dates: [...], rows: [{name, values: {date: 'O'|'X'}}] } 형태로 변환
function parseAttendanceBlock(text, year) {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.trim() !== "");
  if (!lines.length) return { dates: [], rows: [] };

  const header = parseDelimitedLine(lines[0]).map(c => c.trim());
  const nameColIdx = header.findIndex(h => h === "이름");
  const nameCol = nameColIdx >= 0 ? nameColIdx : 0;

  const dateCols = [];
  header.forEach((h, idx) => {
    const m = h.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m) {
      const mo = m[1].padStart(2, "0");
      const da = m[2].padStart(2, "0");
      dateCols.push({ idx, date: `${year}-${mo}-${da}` });
    }
  });

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseDelimitedLine(lines[i]).map(c => c.trim());
    const name = cells[nameCol];
    if (!name) continue;
    const values = {};
    dateCols.forEach(dc => {
      const raw = (cells[dc.idx] || "").trim();
      if (!raw) return; // 빈 칸은 "데이터 없음"으로 간주(해당 학생만 그 주 기록 건너뜀)
      values[dc.date] = /^[oO○Oo]/.test(raw) || raw === "출석" ? "O" : "X";
    });
    rows.push({ name, values });
  }

  return { dates: dateCols.map(d => d.date), rows };
}
