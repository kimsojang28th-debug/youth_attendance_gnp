// ============================================================
// 청소년부 재적관리 - 서버 기능 (Cloud Functions, 서울 리전)
// ------------------------------------------------------------
// 로그인은 "이름 + 연락처 + 비밀번호"로 하고, 교사현황(teachers)에 등록된 교사만 가입/로그인할 수 있습니다.
// 비밀번호는 Firebase 인증이 안전하게 보관하며(이 코드나 DB에는 저장하지 않음),
// 관리자의 "비밀번호 초기화"는 서버(관리자 권한)에서만 처리할 수 있습니다.
//
//  loginStatus        (공개)  이름+연락처가 교사 명단에 있는지, 이미 가입했는지 확인
//  registerTeacher    (공개)  명단에 있는 교사의 최초 가입 (비밀번호 6자리 이상)
//  requestReset       (공개)  비밀번호 재설정 요청 (관리자 화면에 알림)
//  syncSystemAdmin    (로그인) 시스템 관리자 이메일 계정의 권한 문서를 만들어줌
//  adminResetPassword (관리자) 교사 비밀번호 초기화 (다시 처음처럼 가입하게 됨)
//  adminSetRole       (시스템관리자) 일반관리자 지정/해제
//  adminDeleteAccount (관리자) 교사 삭제 전에 계정 정리
// ============================================================
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();
const FieldValue = admin.firestore.FieldValue;

const SYSTEM_EMAIL = "kimsojang.28th@gmail.com"; // 시스템 관리자 (이메일 로그인 유지)
const EMAIL_DOMAIN = "youth-gnp.local";            // 교사 계정용 내부 주소(실제 메일 아님)
const MIN_PASSWORD = 6;

const fn = functions.region("asia-northeast3").runWith({ maxInstances: 10, timeoutSeconds: 30 });
const HttpsError = functions.https.HttpsError;

const digits = (s) => String(s || "").replace(/\D/g, "");
const normName = (s) => String(s || "").replace(/\s+/g, "");
const uidFor = (teacherId) => `t_${teacherId}`;
const emailFor = (teacherId) => `t-${String(teacherId).toLowerCase()}@${EMAIL_DOMAIN}`;

// 이름 + 연락처(숫자만 비교)가 모두 같은 교사 한 명을 찾는다
async function findTeacher(name, phone) {
  const n = normName(name);
  const d = digits(phone);
  if (!n || d.length < 9) return null;
  const snap = await db.collection("teachers").get();
  const hit = snap.docs.find((x) => {
    const t = x.data();
    return normName(t.name) === n && digits(t.phone) === d;
  });
  return hit || null;
}

async function requireAdmin(context) {
  if (!context.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const snap = await db.collection("users").doc(context.auth.uid).get();
  const u = snap.exists ? snap.data() : null;
  if (!u || u.role !== "admin") throw new HttpsError("permission-denied", "관리자만 할 수 있습니다.");
  return { uid: context.auth.uid, isSystem: u.isSystem === true };
}

async function removeAccountOf(teacherDoc) {
  const t = teacherDoc.data();
  const uid = t.uid || uidFor(teacherDoc.id);
  try {
    await auth.deleteUser(uid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
  }
  await db.collection("users").doc(uid).delete();
}

// ---- 공개: 로그인 전 확인 ----
exports.loginStatus = fn.https.onCall(async (data) => {
  const snap = await findTeacher(data && data.name, data && data.phone);
  if (!snap) return { status: "not_in_roster" };
  const t = snap.data();
  if (t.loginEnabled === false) return { status: "disabled" };
  return { status: t.uid ? "registered" : "needs_register", email: emailFor(snap.id) };
});

// ---- 공개: 최초 가입 ----
exports.registerTeacher = fn.https.onCall(async (data) => {
  const password = String((data && data.password) || "");
  if (password.length < MIN_PASSWORD) {
    throw new HttpsError("invalid-argument", `비밀번호는 ${MIN_PASSWORD}자리 이상이어야 합니다.`);
  }
  const snap = await findTeacher(data && data.name, data && data.phone);
  if (!snap) throw new HttpsError("not-found", "교사 명단에 없는 이름/연락처입니다.");
  const t = snap.data();
  if (t.loginEnabled === false) throw new HttpsError("permission-denied", "로그인이 제한된 계정입니다. 관리자에게 문의해주세요.");
  if (t.uid) throw new HttpsError("already-exists", "이미 가입된 교사입니다. 비밀번호를 입력해 로그인해주세요.");

  const uid = uidFor(snap.id);
  const email = emailFor(snap.id);
  try {
    await auth.createUser({ uid, email, password, displayName: t.name });
  } catch (e) {
    if (e.code === "auth/uid-already-exists" || e.code === "auth/email-already-exists") {
      // 이전 가입이 중간에 끊긴 흔적 - 새 비밀번호로 덮어써서 이어서 진행
      await auth.updateUser(uid, { password, email, displayName: t.name });
    } else {
      console.error(e);
      throw new HttpsError("internal", "가입 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
    }
  }
  await db.collection("users").doc(uid).set({
    teacherId: snap.id,
    name: t.name,
    role: t.isAdmin === true ? "admin" : "teacher",
    createdAt: FieldValue.serverTimestamp()
  });
  await snap.ref.update({ uid, registeredAt: FieldValue.serverTimestamp(), resetRequested: false });
  return { ok: true, email };
});

// ---- 공개: 비밀번호 재설정 요청 ----
exports.requestReset = fn.https.onCall(async (data) => {
  const snap = await findTeacher(data && data.name, data && data.phone);
  if (!snap) return { status: "not_in_roster" };
  const t = snap.data();
  if (t.loginEnabled === false) return { status: "disabled" };
  if (!t.uid) return { status: "needs_register" };
  await snap.ref.update({ resetRequested: true, resetRequestedAt: FieldValue.serverTimestamp() });
  return { status: "requested" };
});

// ---- 시스템 관리자(이메일 계정) 권한 문서 ----
exports.syncSystemAdmin = fn.https.onCall(async (data, context) => {
  if (!context.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  const tok = context.auth.token;
  const provider = tok.firebase && tok.firebase.sign_in_provider;
  if (String(tok.email || "").toLowerCase() !== SYSTEM_EMAIL || provider !== "password") {
    throw new HttpsError("permission-denied", "시스템 관리자 계정이 아닙니다.");
  }
  await db.collection("users").doc(context.auth.uid).set({
    name: "시스템관리자", role: "admin", isSystem: true, updatedAt: FieldValue.serverTimestamp()
  });
  return { ok: true };
});

// ---- 관리자: 비밀번호 초기화 ----
exports.adminResetPassword = fn.https.onCall(async (data, context) => {
  const me = await requireAdmin(context);
  const snap = await db.collection("teachers").doc(String((data && data.teacherId) || "-")).get();
  if (!snap.exists) throw new HttpsError("not-found", "교사 정보를 찾을 수 없습니다.");
  const t = snap.data();
  if (t.isAdmin === true && !me.isSystem) {
    throw new HttpsError("permission-denied", "일반관리자의 비밀번호는 시스템 관리자만 초기화할 수 있습니다.");
  }
  if (t.uid) await removeAccountOf(snap);
  await snap.ref.update({ uid: FieldValue.delete(), resetRequested: false, resetAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// ---- 시스템 관리자: 일반관리자 지정/해제 ----
exports.adminSetRole = fn.https.onCall(async (data, context) => {
  const me = await requireAdmin(context);
  if (!me.isSystem) throw new HttpsError("permission-denied", "시스템 관리자만 할 수 있습니다.");
  const snap = await db.collection("teachers").doc(String((data && data.teacherId) || "-")).get();
  if (!snap.exists) throw new HttpsError("not-found", "교사 정보를 찾을 수 없습니다.");
  const makeAdmin = !!(data && data.admin);
  await snap.ref.update({ isAdmin: makeAdmin });
  const t = snap.data();
  if (t.uid) await db.collection("users").doc(t.uid).update({ role: makeAdmin ? "admin" : "teacher" });
  return { ok: true, isAdmin: makeAdmin };
});

// ---- 관리자: 교사 삭제 전 계정 정리 ----
exports.adminDeleteAccount = fn.https.onCall(async (data, context) => {
  const me = await requireAdmin(context);
  const snap = await db.collection("teachers").doc(String((data && data.teacherId) || "-")).get();
  if (!snap.exists) return { ok: true };
  const t = snap.data();
  if (t.isAdmin === true && !me.isSystem) {
    throw new HttpsError("permission-denied", "일반관리자는 시스템 관리자만 삭제할 수 있습니다.");
  }
  if (t.uid) await removeAccountOf(snap);
  return { ok: true };
});
