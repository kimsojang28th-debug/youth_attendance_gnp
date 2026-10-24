// 서버 기능(Cloud Functions, 서울 리전) 호출 도우미.
// 별도 라이브러리 없이 "callable" 규격(POST {data}) 그대로 호출한다. 로그인 상태면 인증 토큰을 함께 보낸다.
import { auth } from "./firebase-init.js";
import { firebaseConfig } from "./firebase-config.js";

const REGION = "asia-northeast3";

export async function callFn(name, data = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth.currentUser) headers.Authorization = "Bearer " + await auth.currentUser.getIdToken();
  let res;
  try {
    res = await fetch(`https://${REGION}-${firebaseConfig.projectId}.cloudfunctions.net/${name}`, {
      method: "POST", headers, body: JSON.stringify({ data })
    });
  } catch (e) {
    const err = new Error("서버에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.");
    err.code = "network";
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const err = new Error(json.error?.message || "요청을 처리하지 못했습니다.");
    err.code = json.error?.status || "error";
    throw err;
  }
  return json.result;
}
