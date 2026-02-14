@echo off
chcp 65001 >nul
cd /d "%~dp0"

set REMOTE_URL=https://github.com/jscometrue/stock_status.git
set BRANCH=main

echo ========================================
echo   GitHub 푸시 (한번에 반영)
echo ========================================
echo.

REM Git 초기화 (최초 1회)
if not exist ".git" (
    echo [최초 설정] Git 초기화 및 원격 저장소 연결...
    git init
    git remote add origin %REMOTE_URL%
    git branch -M %BRANCH%
    echo.
)

REM 변경사항 스테이징
echo [1/3] 변경 파일 추가 중...
git add .
git status
echo.

REM 커밋 (메시지: 인자로 전달되면 사용, 없으면 기본)
set MSG=%~1
if "%MSG%"=="" set MSG=Update

echo [2/3] 커밋 중... (메시지: %MSG%)
git commit -m "%MSG%"
if errorlevel 1 (
    echo 변경사항 없음. 기존 커밋 푸시 시도...
)
echo.

REM 푸시
echo [3/3] GitHub 푸시 중...
git push -u origin %BRANCH%
if errorlevel 1 (
    echo.
    echo 푸시 실패. 최초 푸시 시 GitHub에 기존 커밋이 있으면 다음을 시도하세요:
    echo   git pull origin %BRANCH% --allow-unrelated-histories --no-edit
    echo   git push -u origin %BRANCH%
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   푸시 완료: https://github.com/jscometrue/stock_status
echo ========================================
pause
