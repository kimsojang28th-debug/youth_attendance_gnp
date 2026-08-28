# ============================================================
#  청소년부 재적관리 앱 - GitHub 배포 스크립트 (PowerShell)
#
#  사용법: 이 폴더에서 PowerShell을 열고 아래처럼 실행하세요.
#      .\deploy.ps1
#
#  "실행할 수 없습니다(스크립트 실행이 비활성화됨)" 오류가 나면,
#  PowerShell을 한 번만 아래처럼 열어서 실행 정책을 풀어주세요.
#      Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# ============================================================

$ErrorActionPreference = "Stop"
$repoPath  = $PSScriptRoot
$remoteUrl = "https://github.com/kimsojang28th-debug/youth_attendance_gnp.git"

Set-Location $repoPath

# 1) git 설치 확인
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git이 설치되어 있지 않습니다." -ForegroundColor Red
    Write-Host "https://git-scm.com/download/win 에서 설치한 뒤 이 스크립트를 다시 실행해주세요."
    exit 1
}

# 2) 최초 1회: 이 폴더를 GitHub 저장소와 연결
if (-not (Test-Path ".git")) {
    Write-Host "처음 배포네요 - 이 폴더를 GitHub 저장소와 연결합니다..." -ForegroundColor Yellow

    git init | Out-Null
    git remote add origin $remoteUrl
    git branch -M main

    if (-not (git config user.email)) {
        Write-Host "Git에 커밋 작성자 정보가 없어서 한 번만 입력받을게요 (GitHub 로그인 계정과 달라도 무방합니다)." -ForegroundColor Cyan
        $email = Read-Host "이메일"
        $name  = Read-Host "이름"
        git config user.email $email
        git config user.name  $name
    }

    git add -A
    git commit -m "로컬 작업 폴더 초기 연결"

    Write-Host ""
    Write-Host "주의: 지금 GitHub의 main 브랜치 내용을 이 폴더 내용으로 덮어씁니다." -ForegroundColor Yellow
    Write-Host "      (지금까지 GitHub에는 이 폴더 파일들을 그대로 올려왔으므로 안전합니다.)" -ForegroundColor Yellow
    $confirm = Read-Host "계속할까요? (y/n)"
    if ($confirm -ne "y") {
        Write-Host "취소했습니다."
        exit 0
    }

    Write-Host "잠시 후 브라우저 창이 뜨면 GitHub 계정으로 로그인/승인해주세요." -ForegroundColor Cyan
    git push -u origin main --force
}
# 3) 두 번째부터: 바뀐 내용만 커밋 + 푸시
else {
    git add -A
    $changes = git status --porcelain
    if ([string]::IsNullOrWhiteSpace($changes)) {
        Write-Host "새로 바뀐 내용이 없어요. 배포할 게 없습니다." -ForegroundColor Cyan
        exit 0
    }

    $msg = Read-Host "이번 변경 내용을 한 줄로 적어주세요 (그냥 Enter 누르면 자동 메시지)"
    if ([string]::IsNullOrWhiteSpace($msg)) {
        $msg = "업데이트 " + (Get-Date -Format "yyyy-MM-dd HH:mm")
    }
    git commit -m $msg
    git push
}

Write-Host ""
Write-Host "배포 완료! GitHub Actions가 자동으로 Firebase Hosting에 반영합니다 (보통 1~2분)." -ForegroundColor Green
Write-Host "진행 상황:  https://github.com/kimsojang28th-debug/youth_attendance_gnp/actions"
Write-Host "배포 사이트: https://youth-attendance-gnp.web.app"
