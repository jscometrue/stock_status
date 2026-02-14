@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   금융 지수 주가 대시보드
echo ========================================
echo.

REM 포트 3000 사용 프로세스 확인 및 종료
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000.*LISTENING" 2^>nul') do (
    echo [기존 서버 종료] PID %%a
    taskkill /F /PID %%a >nul 2>&1
    timeout /t 1 /nobreak >nul
)

echo [서버 시작] http://localhost:3000
echo.
echo 브라우저에서 접속하세요. 종료하려면 Ctrl+C 를 누르세요.
echo ========================================
echo.

npm start

pause
