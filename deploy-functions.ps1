# ============================================================
#  청소년부 재적관리 앱 - 서버 기능 + 보안 규칙 배포 (PowerShell)
#
#  사용법:  Set-Location "D:\Claude_Cowork\청소년부재적관리프로그램"; .\deploy-functions.ps1
#
#  - 로그인/가입/비밀번호 초기화 서버 기능(functions)과 Firestore 보안 규칙을 Firebase에 올립니다.
#  - 화면(앱 본체)은 기존대로 .\deploy.ps1 로 올립니다.
#  - 처음 한 번은 Node.js(https://nodejs.org, LTS)가 설치되어 있어야 하고, 아래 로그인이 필요합니다.
# ============================================================
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해주세요." -ForegroundColor Red
    exit 1
}

# Firebase 도구는 따로 설치하지 않고 npx 로 바로 실행합니다.
$fb = @("--yes", "firebase-tools@latest")

Write-Host "1) Firebase 로그인 확인 (처음이면 브라우저가 열립니다. 시스템 관리자 구글 계정으로 로그인하세요)" -ForegroundColor Cyan
npx @fb login:list
if ($LASTEXITCODE -ne 0) { npx @fb login }

Write-Host ""
Write-Host "2) 서버 기능에 필요한 패키지 설치 (처음에는 1~2분 걸립니다)" -ForegroundColor Cyan
Push-Location (Join-Path $PSScriptRoot "functions")
npm install --no-audit --no-fund
$npmExit = $LASTEXITCODE
Pop-Location
if ($npmExit -ne 0) { Write-Host "패키지 설치에 실패했습니다. 위 메시지를 알려주세요." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "3) 서버 기능 배포 (처음에는 몇 분 걸립니다. 처음 한 번은 API 활성화 직후라 실패할 수 있으니, 실패하면 1~2분 뒤 다시 실행해주세요)" -ForegroundColor Cyan
npx @fb deploy --only functions --project youth-attendance-gnp
if ($LASTEXITCODE -ne 0) { Write-Host "서버 기능 배포에 실패했습니다. 위 메시지를 알려주세요." -ForegroundColor Red; exit 1 }

Write-Host ""
$ans = Read-Host "4) 보안 규칙도 지금 새 규칙으로 바꿀까요? (화면 배포 .\deploy.ps1 와 시스템관리자 로그인 확인을 끝낸 뒤에 y 를 권장) (y/n)"
if ($ans -eq "y") {
    npx @fb deploy --only firestore:rules --project youth-attendance-gnp
    if ($LASTEXITCODE -ne 0) { Write-Host "규칙 배포에 실패했습니다." -ForegroundColor Red; exit 1 }
}
Write-Host "완료되었습니다." -ForegroundColor Green
