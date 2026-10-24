import {
  auth, db, signInWithEmailAndPassword, signOut, onAuthStateChanged, doc, getDoc
} from "./firebase-init.js";
import { $ } from "./utils.js";
import { callFn } from "./functions-client.js";

// 시스템 관리자(이메일 로그인 유지) - functions/index.js 의 SYSTEM_EMAIL 과 같아야 함
const SYSTEM_EMAIL = "kimsojang.28th@gmail.com";
const MIN_PASSWORD = 6;

// 현재 로그인한 사용자 정보
export const currentUser = {
  uid: null,
  email: null,
  name: "",
  role: "teacher",   // 'admin'(관리자) | 'teacher'
  isSystem: false,   // 시스템 관리자 여부
  teacherId: null,   // 교사현황(teachers) 문서 id
  classIds: []       // 담당반(표시용 + 재적부 수정 권한용). 출석 입력은 모든 반에서 가능
};

export function isAdmin() {
  return currentUser.role === "admin";
}

export function isSystemAdmin() {
  return currentUser.isSystem === true;
}

// 출석 입력은 모든 교사가 모든 반에서 할 수 있음(대리 진행 때문). 재적부(학생 정보) 수정만 담당반/관리자로 제한.
export function canEditClass(classId) {
  return isAdmin() || currentUser.classIds.includes(classId);
}

export function canAccessClass(classId) {
  return canEditClass(classId);
}

const digitsOnly = (s) => String(s || "").replace(/\D/g, "");

function formatPhone(raw) {
  const d = digitsOnly(raw).slice(0, 11);
  if (d.length < 4) return d;
  if (d.length < 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
  if (d.length < 11) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}

let _logoutNotice = "";

export function initAuth({ onLogin, onLogout }) {
  const loginForm = $("#loginForm");
  const loginError = $("#loginError");
  const submitBtn = $("#loginSubmit");
  const confirmWrap = $("#loginConfirmWrap");
  const nameInput = $("#loginName");
  const phoneInput = $("#loginPhone");
  const pwInput = $("#loginPassword");
  const pw2Input = $("#loginPassword2");

  const say = (msg, ok = false) => {
    loginError.textContent = msg || "";
    loginError.classList.toggle("ok", !!ok);
  };
  const busy = (on, label) => {
    submitBtn.disabled = on;
    submitBtn.textContent = on ? (label || "확인 중...") : (confirmWrap.classList.contains("hidden") ? "로그인 / 시작하기" : "가입하고 시작하기");
  };
  const hideConfirm = () => {
    confirmWrap.classList.add("hidden");
    pw2Input.value = "";
    pw2Input.required = false;
    submitBtn.textContent = "로그인 / 시작하기";
  };

  // 이름/연락처가 바뀌면 "처음 가입" 상태를 해제
  phoneInput.addEventListener("input", () => { phoneInput.value = formatPhone(phoneInput.value); hideConfirm(); });
  nameInput.addEventListener("input", hideConfirm);

  // 비밀번호 보기/숨기기
  document.querySelectorAll(".pw-toggle").forEach(btn => {
    btn.onclick = () => {
      const input = document.getElementById(btn.dataset.target);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "숨김" : "보기";
    };
  });

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    say("");
    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    const password = pwInput.value;
    if (!name) return say("이름을 입력해주세요.");
    if (digitsOnly(phone).length < 10) return say("연락처를 정확히 입력해주세요. (예: 010-1234-5678)");
    if (password.length < MIN_PASSWORD) return say(`비밀번호는 ${MIN_PASSWORD}자리 이상 입력해주세요.`);

    try {
      busy(true);
      const firstTime = !confirmWrap.classList.contains("hidden");

      if (firstTime) {
        // 처음 가입: 비밀번호를 한 번 더 입력해 오타를 방지
        if (pw2Input.value !== password) { busy(false); return say("비밀번호가 서로 다릅니다. 같은 비밀번호를 두 번 입력해주세요."); }
        const r = await callFn("registerTeacher", { name, phone, password });
        await signInWithEmailAndPassword(auth, r.email, password);
        return; // onAuthStateChanged 에서 이어서 처리
      }

      const st = await callFn("loginStatus", { name, phone });
      if (st.status === "not_in_roster") {
        busy(false);
        return say("교사 명단에 없는 이름/연락처입니다. 이름과 연락처를 다시 확인하시거나 관리자에게 문의해주세요.");
      }
      if (st.status === "disabled") {
        busy(false);
        return say("로그인이 제한된 계정입니다. 관리자에게 문의해주세요.");
      }
      if (st.status === "needs_register") {
        confirmWrap.classList.remove("hidden");
        pw2Input.required = true;
        busy(false);
        pw2Input.focus();
        return say("처음 접속하셨습니다. 방금 입력한 비밀번호를 한 번 더 입력하면 가입이 완료됩니다.", true);
      }
      await signInWithEmailAndPassword(auth, st.email, password);
    } catch (err) {
      busy(false);
      console.error(err);
      if (err.code === "auth/too-many-requests") say("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.");
      else if (err.code && String(err.code).startsWith("auth/")) say("비밀번호가 맞지 않습니다. 잊으셨다면 아래 '재설정 요청'을 눌러주세요.");
      else say(err.message || "로그인 중 오류가 발생했습니다.");
    }
  });

  // 비밀번호 재설정 요청 (관리자가 초기화해 줌)
  $("#resetRequestBtn").onclick = async () => {
    say("");
    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    if (!name || digitsOnly(phone).length < 10) return say("이름과 연락처를 입력한 뒤 '재설정 요청'을 눌러주세요.");
    try {
      const r = await callFn("requestReset", { name, phone });
      if (r.status === "requested") say("재설정을 요청했습니다. 관리자가 초기화하면 처음처럼 새 비밀번호를 만들 수 있습니다.", true);
      else if (r.status === "needs_register") say("아직 가입 전입니다. 비밀번호를 입력하고 '로그인 / 시작하기'를 눌러 가입해주세요.", true);
      else if (r.status === "disabled") say("로그인이 제한된 계정입니다. 관리자에게 문의해주세요.");
      else say("교사 명단에 없는 이름/연락처입니다. 관리자에게 문의해주세요.");
    } catch (err) { say(err.message || "요청 중 오류가 발생했습니다."); }
  };

  // 시스템 관리자 로그인 (이메일)
  const sysForm = $("#sysLoginForm");
  $("#sysLoginToggle").onclick = () => sysForm.classList.toggle("hidden");
  sysForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    say("");
    try {
      await signInWithEmailAndPassword(auth, $("#sysEmail").value.trim(), $("#sysPassword").value);
    } catch (err) {
      console.error(err);
      say("로그인 실패: 이메일 또는 비밀번호를 확인해주세요.");
    }
  });

  $("#logoutBtn").addEventListener("click", () => signOut(auth));

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      currentUser.uid = null;
      onLogout();
      if (_logoutNotice) { say(_logoutNotice); _logoutNotice = ""; }
      busy(false);
      return;
    }
    const deny = async (msg) => { _logoutNotice = msg; await signOut(auth); };
    try {
      if ((user.email || "").toLowerCase() === SYSTEM_EMAIL) await callFn("syncSystemAdmin");
      const snap = await getDoc(doc(db, "users", user.uid));
      const data = snap.exists() ? snap.data() : null;
      if (!data || (!data.teacherId && !data.isSystem)) {
        return deny("등록된 교사 계정이 아닙니다. 이름과 연락처로 다시 로그인해주세요.");
      }
      currentUser.uid = user.uid;
      currentUser.email = user.email;
      currentUser.name = data.name || "";
      currentUser.role = data.role === "admin" ? "admin" : "teacher";
      currentUser.isSystem = data.isSystem === true;
      currentUser.teacherId = data.teacherId || null;
      currentUser.classIds = [];
      if (data.teacherId) {
        const tSnap = await getDoc(doc(db, "teachers", data.teacherId));
        if (!tSnap.exists()) return deny("교사 명단에서 삭제된 계정입니다. 관리자에게 문의해주세요.");
        const t = tSnap.data();
        if (t.loginEnabled === false) return deny("로그인이 제한된 계정입니다. 관리자에게 문의해주세요.");
        currentUser.name = t.name || currentUser.name;
        currentUser.classIds = Array.isArray(t.classIds) ? t.classIds : [];
      }
    } catch (err) {
      console.error("사용자 정보 조회 실패", err);
      return deny("사용자 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
    }
    const roleLabel = currentUser.isSystem ? "시스템관리자" : (currentUser.role === "admin" ? "일반관리자" : "교사");
    $("#userLabel").textContent = currentUser.isSystem ? roleLabel : `${currentUser.name} (${roleLabel})`;
    onLogin();
  });
}
