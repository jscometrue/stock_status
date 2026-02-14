# 금융 지수·주가 일별 대시보드

코스피, S&P500, 필라델피아반도체, 주요 주식 등 19개 항목의 일별 마감 데이터를 테이블·차트·이벤트로 확인할 수 있는 웹 대시보드입니다.

## 기능

- **테이블**: 월별 일별 마감가, 전일 대비 상승(↑ 녹색)/하락(↓ 빨간색) 표시
- **업데이트**: 당일·최근 데이터로 갱신
- **차트**: 모든 항목의 월별 일별 가격 추이 (가로 4개 그리드)
- **뉴스/이벤트**: 가격 변동 3% 이상이면서, 해당 상승/하락 이유를 설명한 뉴스 기사가 있는 경우만 표시
- 모든 메뉴에서 월별 선택 가능

## 실행 방법

### 방법 1: 배치 파일 (권장)

`start.bat` 더블클릭 실행

- 기존 서버(포트 3000) 자동 종료 후 시작
- 브라우저에서 http://localhost:3000 접속

### 방법 2: 명령어

```bash
npm install
npm start
```

### 방법 3: GitHub 푸시 (로컬 → 원격 한번에)

`push.bat` 더블클릭 실행 (또는 `push.bat "커밋 메시지"` 로 메시지 지정)

- Git 미초기화 시: 자동 init 및 `jscometrue/stock_status` 원격 연결
- 변경 파일 추가 → 커밋 → 푸시를 한 번에 수행

## 데이터 출처

- Yahoo Finance (비공식 Chart API)
- 뉴스: Finnhub API (이벤트 필터링용)

## 환경 변수

- `FINNHUB_API_KEY`: Finnhub API 키 (https://finnhub.io 에서 무료 발급). 설정 시 뉴스/이벤트 메뉴에서 해당 항목 상승/하락 이유를 설명한 뉴스가 있는 경우만 이벤트 표시. 미설정 시 이벤트가 표시되지 않음.

## 문서

- `docs/SOFTWARE_ARCHITECTURE.md` : 소프트웨어 아키텍처, 프로그램 구성, 데이터 흐름, 코드 검증 가이드

## Render 배포

### 1. GitHub 연동 후 배포

1. [Render](https://render.com) 가입 후 로그인
2. **New** → **Web Service** 선택
3. GitHub 저장소 연결 후 본 프로젝트 선택
4. 설정:
   - **Name**: `stock-status-dashboard` (원하는 이름)
   - **Region**: Singapore 또는 가까운 지역
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (또는 필요 시 유료)
5. **Environment** 탭에서:
   - `FINNHUB_API_KEY`: Finnhub API 키 입력 (선택, 뉴스/이벤트용)
6. **Create Web Service** 클릭

### 2. Blueprint (render.yaml)로 배포

저장소에 `render.yaml`이 있으면 Render 대시보드에서 **New** → **Blueprint**로 해당 저장소를 선택하면 서비스가 자동 생성됩니다. 이후 Environment에서 `FINNHUB_API_KEY`만 추가하면 됩니다.

### 배포 후

- URL: `https://<서비스명>.onrender.com`
- 무료 플랜: 15분 미사용 시 슬립, 최초 접속 시 약 30초~1분 대기 가능
- `data/` 캐시는 인스턴스 재시작 시 초기화됨 (ephemeral filesystem)

---

## 주의

- Yahoo Finance 비공식 API 사용
- 장중 실시간 데이터가 아닌 일별 마감 기준
