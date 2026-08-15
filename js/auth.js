import {
  auth, db, signInWithEmailAndPassword, signOut, onAuthStateChanged, doc, getDoc
} from "./firebase-init.js";
import { $ } from "./utils.js";

// 현재 로그인한 사용자 프로필 (Firestore users/{uid} 문서 내용 포함)
export const currentUser = {
  uid: null,
  email: null,
  name: "",
  role: "teacher", // 'admin' | 'teacher'
  classIds: []      // 관리자(admin)는 전체 반 접근 가능, teacher는 이 목록만
};

export function isAdmin() {
  return currentUser.role === "admin";
}

export function canAccessClass(classId) {
  return isAdmin() || currentUser.classIds.includes(classId);
}

export function initAuth({ onLogin, onLogout }) {
  const loginForm = $("#loginForm");
  const loginError = $("#loginError");
  const logoutBtn = $("#logoutBtn");

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.textContent = "";
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      loginError.textContent = "로그인 실패: 이메일 또는 비밀번호를 확인해주세요.";
      console.error(err);
    }
  });

  logoutBtn.addEventListener("click", () => signOut(auth));

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser.uid = user.uid;
      currentUser.email = user.email;
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) {
          const data = snap.data();
          currentUser.name = data.name || user.email;
          currentUser.role = data.role || "teacher";
          currentUser.classIds = data.classIds || [];
        } else {
          // users 문서가 아직 없으면 기본값(teacher, 반 없음)으로 처리
          currentUser.name = user.email;
          currentUser.role = "teacher";
          currentUser.classIds = [];
          console.warn("Firestore users/" + user.uid + " 문서가 없습니다. 관리자에게 계정 등록을 요청하세요.");
        }
      } catch (err) {
        console.error("사용자 정보 조회 실패", err);
      }
      $("#userLabel").textContent = `${currentUser.name} (${currentUser.role === "admin" ? "부장/관리자" : "교사"})`;
      onLogin();
    } else {
      currentUser.uid = null;
      onLogout();
    }
  });
}
