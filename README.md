# 청소년부 재적관리 프로그램

기존에 구글시트로 운영하시던 청소년부 출결/재적 관리를, 로그인이 되는 웹앱으로 옮긴 버전입니다.
- 반별 선생님: 주일마다 자기 반 출석체크
- 부장님(관리자): 전체 반 현황, 주간보고서, 장기결석자, 통계, 재적변동이력 관리

**기술 구성**: 순수 HTML/CSS/JS (빌드 과정 없음) + Firebase (로그인 + 데이터 저장) + GitHub + Netlify(배포)

빌드 도구가 전혀 없는 정적 사이트라서, GitHub에 올리고 Netlify에 연결만 하면 바로 배포됩니다.

---

## 폴더 구조

```
index.html              메인 화면 (모든 화면이 이 한 페이지 안에서 전환됩니다)
css/style.css            스타일
js/firebase-config.js    ⚠️ Firebase 프로젝트 키를 넣는 파일 (직접 채워야 함)
js/firebase-init.js      Firebase 초기화
js/auth.js               로그인/로그아웃, 관리자·교사 권한 구분
js/classes.js            반(학년/반) 목록
js/students.js           재적부(학생 명단) 관리, CSV 일괄등록
js/attendance.js         주일 출석체크
js/report.js             주간보고서 (설교/헌금/심방 + 출석 자동집계)
js/annual.js             연간출석부 (주별 O/X 그리드)
js/stats.js              통계 차트 (반별/학년별/월별 출석률)
js/absentee.js           장기결석자 자동 감지
js/dashboard.js          대시보드
js/history.js            재적 변동 이력
js/app.js                화면 전환(라우팅) 진입점
firestore.rules          Firestore 보안 규칙
netlify.toml             Netlify 배포 설정
```

---

## 1단계. GitHub에 올리기

1. GitHub에서 새 저장소(Repository)를 만듭니다. (예: `youth-attendance-app`, Public도 무방하지만 Private 권장)
2. 이 폴더 전체를 저장소에 업로드합니다.
   ```bash
   cd youth-attendance-app
   git init
   git add .
   git commit -m "청소년부 재적관리 프로그램 초기 버전"
   git branch -M main
   git remote add origin https://github.com/사용자명/저장소명.git
   git push -u origin main
   ```

## 2단계. Firebase 프로젝트 만들기

1. https://console.firebase.google.com 접속 → **프로젝트 추가** → 이름 입력(예: `youth-attendance`) → 애널리틱스는 꺼도 무방합니다.
2. 왼쪽 메뉴 **빌드 > Authentication** → "시작하기" → **로그인 방법** 탭에서 **이메일/비밀번호** 사용 설정.
3. 왼쪽 메뉴 **빌드 > Firestore Database** → "데이터베이스 만들기" → 위치는 `asia-northeast3(서울)` 추천 → 우선 **테스트 모드**로 시작해도 되지만, 이후 반드시 4단계의 보안 규칙으로 교체하세요.
4. 프로젝트 설정(⚙️ 톱니바퀴) → **내 앱** → `</>` (웹 앱 추가) 클릭 → 앱 닉네임 입력 → "Firebase Hosting 설정"은 체크하지 않아도 됩니다 → 등록하면 `firebaseConfig` 값이 나옵니다.
5. 그 값을 `js/firebase-config.js` 파일에 그대로 붙여넣습니다.
   ```js
   export const firebaseConfig = {
     apiKey: "AIza....",
     authDomain: "youth-attendance-xxxx.firebaseapp.com",
     projectId: "youth-attendance-xxxx",
     storageBucket: "youth-attendance-xxxx.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:xxxxxxxxxxxx"
   };
   ```
6. 파일을 수정했다면 다시 GitHub에 커밋/푸시하세요.

## 3단계. 관리자(부장) 계정 만들기

앱 자체에는 회원가입 화면이 없습니다(교회 내부용이라 관리자가 직접 계정을 만들어주는 방식입니다).

1. Firebase 콘솔 → **Authentication > Users** → "사용자 추가" → 부장님의 이메일/비밀번호 입력.
2. 방금 만든 사용자의 **UID**를 복사해둡니다.
3. Firebase 콘솔 → **Firestore Database > 데이터** → "컬렉션 시작" → 컬렉션 ID: `users` → 문서 ID에 **위에서 복사한 UID를 그대로 붙여넣기** → 아래 필드 추가:
   | 필드명 | 유형 | 값 |
   |---|---|---|
   | name | string | 예: 최규석 부장 |
   | role | string | `admin` |
   | classIds | array | 비워둬도 됩니다 (admin은 전체 접근) |
4. 저장 후, 웹앱에서 이 이메일/비밀번호로 로그인하면 관리자로 접속됩니다. **처음 관리자로 로그인하면 기본 반(중1~고3, 새친구) 목록이 자동으로 생성됩니다.**

**반별 선생님 계정을 추가하려면** 같은 방식으로 Authentication에 사용자 추가 → `users` 컬렉션에 문서 추가 시 `role`을 `teacher`로, `classIds`에 담당 반의 ID를 배열로 넣어주세요. 반 ID는 기본값 기준 아래와 같습니다.

| 반 | classId |
|---|---|
| 중1 | `mid1` |
| 중2 | `mid2` |
| 중3 | `mid3` |
| 고1남 | `high1_m` |
| 고1여 | `high1_f` |
| 고2남 | `high2_m` |
| 고2여 | `high2_f` |
| 고3 | `high3` |
| 새친구 | `newcomer` |

예: 중1 담당 선생님이면 `classIds: ["mid1"]`.

> 반 구성을 바꾸고 싶다면(이름, 개수 등) Firestore의 `classes` 컬렉션 문서를 직접 수정하거나 `js/classes.js`의 `DEFAULT_CLASSES` 배열을 수정한 뒤 다시 배포하세요.

## 4단계. 보안 규칙 적용

Firebase 콘솔 → **Firestore Database > 규칙** 탭 → 이 저장소의 `firestore.rules` 파일 내용을 그대로 붙여넣고 **게시(Publish)**.

(3단계까지만 하고 이 단계를 건너뛰면 "테스트 모드"의 임시 규칙이 30일 후 만료되어 아무도 접근할 수 없게 되니 꼭 적용해주세요.)

## 5단계. Netlify 배포

1. https://app.netlify.com 접속 → **Add new site > Import an existing project** → GitHub 연동 → 방금 올린 저장소 선택.
2. Build command는 비워두고, Publish directory는 `.` (루트) 로 지정 → Deploy.
3. 배포가 끝나면 `https://xxxx.netlify.app` 주소가 생성됩니다. Site settings에서 원하는 서브도메인으로 바꿀 수 있습니다.
4. 이후 GitHub에 새 커밋을 푸시할 때마다 자동으로 재배포됩니다.

## 6단계. 기존 구글시트 데이터 옮기기

1. 배포된 사이트에 관리자로 로그인 → **재적부** 메뉴 → **CSV 일괄등록**.
2. 구글시트의 재적부(또는 연간출석부)에서 `이름`, `반이름`, `성별` 열을 복사해서 붙여넣으면 한 번에 등록됩니다. (형식: `이름,반이름,성별` 한 줄에 한 명씩. 예: `정현우,중1,남`)
3. 지난 출석 기록(연간출석부의 과거 O/X)까지 옮기고 싶다면, 반복적인 수작업이 필요합니다. 필요하시면 말씀해주세요 — 구글시트 내용을 기반으로 한 번에 넣어주는 가져오기 스크립트를 추가로 만들어 드릴 수 있습니다.

---

## 사용 방법 요약

- **대시보드**: 이번 주 출석 현황, 3주 이상 연속결석 학생 경고, 반별 현황 한눈에 보기
- **출석체크**: 반과 날짜를 선택하고 이름을 눌러 O/X 전환 후 저장 (기존 시트의 "출석체크 시트" 역할)
- **재적부**: 학생 추가/수정/삭제, 상태(재적/새친구/휴학/전출/제적) 관리
- **주간보고서**: 설교자/설교제목/설교본문/헌금 내역/심방 및 예정사항을 입력하면, 그 주 출석 현황이 자동으로 집계되어 기존 "청소년부 주간보고서"와 동일한 정보를 한 화면에서 볼 수 있습니다.
- **연간출석부**: 반을 선택하면 그 반 학생들의 1년치 O/X를 표로 확인 (기존 "연간출석부 시트" 역할)
- **통계**: 반별/학년별 출석률, 월별 전체 출석 추이 그래프
- **재적변동이력**: 새친구 등록, 전입/전출, 휴학/복학, 제적 등의 변동사항을 시간순으로 기록

## 참고: Firestore 색인(index) 안내

통계·연간출석부·장기결석자 화면은 여러 조건으로 데이터를 조회하기 때문에, 처음 사용할 때 브라우저 개발자도구 콘솔에 "색인을 만들어야 합니다"라는 안내와 함께 링크가 뜰 수 있습니다. 그 링크를 클릭해서 Firebase 콘솔에서 색인 생성을 눌러주시면(1~2분 소요) 이후에는 정상적으로 작동합니다.

## 문제 해결

- **로그인이 안 돼요**: Firebase Authentication에 이메일/비밀번호 로그인 방식이 켜져 있는지, 계정이 실제로 등록되어 있는지 확인하세요.
- **로그인은 되는데 "권한 없음" 비슷한 오류가 나요**: Firestore의 `users/{내 UID}` 문서가 없거나 `role` 값이 비어있을 수 있습니다. 3단계를 다시 확인하세요.
- **데이터가 하나도 안 보여요**: `firestore.rules`를 게시했는지, `js/firebase-config.js`의 값이 정확한지 확인하세요.
