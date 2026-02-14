# Finnhub API 키 설정 가이드

## 1. API 키 발급 (무료)

1. 브라우저에서 **https://finnhub.io/register** 접속 (이미 열렸을 수 있음)
2. 이메일로 회원가입
3. 로그인 후 **https://finnhub.io/dashboard** 이동
4. 대시보드에서 **API Key** 확인 (또는 프로필 > API Key)

## 2. 환경 변수 설정

### 방법 A: .env 파일 사용 (권장)

1. `c:\Cursor\stock_status\.env` 파일을 연다
2. `your_api_key_here` 를 발급받은 API 키로 교체한다

```
FINNHUB_API_KEY=여기에_API_키_붙여넣기
```

### 방법 B: PowerShell에서 직접 설정 후 실행

```powershell
cd c:\Cursor\stock_status
$env:FINNHUB_API_KEY = "발급받은_API_키"
npm start
```

## 3. 서버 실행

```powershell
cd c:\Cursor\stock_status
npm start
```

브라우저에서 http://localhost:3000 접속

## 참고

- API 키 미설정 시: 뉴스/이벤트 메뉴에 이벤트가 표시되지 않음 (다른 메뉴는 정상 동작)
- Finnhub 무료 플랜: 60 API 호출/분
