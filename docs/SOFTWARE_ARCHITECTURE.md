# 금융 지수·주가 일별 대시보드 - Software Architecture Document

> **목적**: 프로그램 코드 검증을 위한 소프트웨어 아키텍처, 구성, 데이터 흐름 문서

---

## Google Docs로 가져오기

1. https://docs.google.com 접속 → 새 문서 만들기
2. 이 파일(`docs/SOFTWARE_ARCHITECTURE.md`)을 메모장 등으로 열어 전체 복사
3. Google Docs에 붙여넣기 (서식 일부 유지됨)
4. 또는: Google Docs 메뉴 → **파일** → **열기** → **업로드** 탭에서 이 `.md` 파일 업로드

---

## 1. 개요

### 1.1 시스템 개요
- **이름**: 금융 지수·주가 일별 대시보드 (Stock Status Dashboard)
- **유형**: Single Page Application (SPA) + REST API 서버
- **기술 스택**: Node.js, Express, Vanilla JavaScript, Chart.js

### 1.2 주요 기능
| 기능 | 설명 |
|------|------|
| 테이블 | 19개 항목 월별 일별 마감가, 전일대비 상승(↑)/하락(↓) 표시 |
| 차트 | 모든 항목의 월별 일별 가격 추이 (가로 4개 그리드, 색상 구분) |
| 뉴스/이벤트 | 가격 변동 3%+ 이면서 관련 뉴스가 있는 이벤트만 표시 |
| 업데이트 | 선택 월의 최신 데이터 갱신 |

---

## 2. Software Architecture

### 2.1 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  index.html │  │  style.css  │  │       app.js            │  │
│  │  (View)     │  │  (Styles)   │  │  (Controller + Logic)   │  │
│  └─────────────┘  └─────────────┘  └───────────┬─────────────┘  │
└────────────────────────────────────────────────┼────────────────┘
                                                 │ HTTP fetch
                                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Node.js Server (Express)                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    REST API Endpoints                        ││
│  │  /api/daily/:year/:month  /api/update/:year/:month           ││
│  │  /api/chart/:symbol/:year/:month  /api/events/:year/:month   ││
│  │  /api/symbols  /api/news/:date                               ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │ Security Layer   │  │ Business Logic   │  │ Data Fetchers │  │
│  │ - Headers        │  │ - Validation     │  │ - Yahoo API   │  │
│  │ - Sanitization   │  │ - Date Range     │  │ - Finnhub API │  │
│  └──────────────────┘  └──────────────────┘  └───────┬───────┘  │
└──────────────────────────────────────────────────────┼──────────┘
                                                       │ HTTPS
                     ┌─────────────────────────────────┼─────────────────┐
                     │                                 │                 │
                     ▼                                 ▼                 ▼
            ┌───────────────┐                ┌───────────────┐  ┌──────────────┐
            │ Yahoo Finance │                │  Finnhub API  │  │   .env       │
            │ Chart API     │                │  (News)       │  │ FINNHUB_KEY  │
            └───────────────┘                └───────────────┘  └──────────────┘
```

### 2.2 아키텍처 패턴
- **Client-Server**: 브라우저(클라이언트) ↔ Express 서버
- **RESTful API**: 상태 없는 HTTP 기반 API
- **MVC 변형**: View(HTML) + Controller(JS) + Server(Model/Data)

---

## 3. 프로그램 구성 (파일 구조)

```
stock_status/
├── server.js              # Express 서버, API 라우트, 데이터 조회 로직
├── package.json           # 의존성 (express, cors, dotenv)
├── .env                   # 환경변수 (FINNHUB_API_KEY) - git 제외
├── .env.example           # 환경변수 템플릿
├── start.bat              # Windows 배치 실행 파일
│
├── config/
│   └── symbols.js         # 19개 항목 정의 (id, name, symbol, unit, newsSymbol)
│
├── public/                # 정적 파일 (클라이언트)
│   ├── index.html         # 메인 페이지, 탭 구조
│   ├── css/
│   │   └── style.css      # 스타일 (다크테마, 그리드, 팝업)
│   └── js/
│       └── app.js         # 클라이언트 로직 (API 호출, 렌더링, Chart.js)
│
└── docs/
    └── SOFTWARE_ARCHITECTURE.md  # 본 문서
```

---

## 4. 데이터 흐름 (Flow)

### 4.1 초기 로드 흐름

```
[페이지 로드]
    │
    ├─► initSelectors()     : 연/월 셀렉터 초기화
    ├─► initTabs()          : 탭 클릭 핸들러
    ├─► initButtons()       : 업데이트, 에러팝업 닫기
    ├─► initChartSymbols()  : (빈 함수, 차트는 전체 로드)
    │
    └─► loadTableData()     : GET /api/daily/{year}/{month}
            │
            └─► renderTable(json)  : 테이블 렌더링
```

### 4.2 테이블 탭 흐름

```
[월 선택 변경] or [업데이트 클릭]
    │
    └─► loadTableData(forceUpdate?)
            │
            ├─ forceUpdate=false  → GET /api/daily/{year}/{month}
            ├─ forceUpdate=true   → GET /api/update/{year}/{month}
            │
            ├─ 성공 → renderTable()
            │         ├─ 날짜별 행 생성
            │         ├─ 항목별 종가 + 전일대비 화살표/색상
            │         └─ formatPrice()
            │
            ├─ 실패 → showErrorPopup()
            └─ failed 있음 → showErrorPopup(일부 누락)
```

### 4.3 차트 탭 흐름

```
[차트 탭 클릭] or [월 선택 변경 시 차트 탭 활성]
    │
    └─► loadAllCharts()
            │
            └─► GET /api/daily/{year}/{month}
                    │
                    └─► 각 item별 Chart 생성 (4열 그리드)
                            │
                            ├─ 색상 결정 로직:
                            │   ├─ 노란: 당월 고점 대비 -5%
                            │   ├─ 빨강: 2일 이상 연속 하락 or 당월 고점 대비 -3%
                            │   └─ 파랑: 기본
                            │
                            └─ Chart.js line 차트 렌더링
```

> **캐시 전략**: 이미 조회한 월별 데이터는 클라이언트 메모리에 저장해 탭 이동 시 즉시 이전 차트를 보여 주고, 동시에 백그라운드에서 신규 데이터를 받아오며 완료 시 갱신합니다.

### 4.4 뉴스/이벤트 탭 흐름

```
[조회 클릭]
    │
    └─► loadEvents()
            │
            └─► GET /api/events/{year}/{month}
                    │
                    │  [서버]
                    │  1. fetchAllHistorical() → Yahoo Chart API (19개)
                    │  2. 후보 이벤트 추출 (변동 3%+)
                    │  3. newsSymbol 있는 항목에 대해 Finnhub 뉴스 조회
                    │  4. 해당 날짜에 뉴스 있는 이벤트만 필터
                    │
                    └─► renderEvents(json)
                            └─ 날짜별 테이블 (날짜, 항목, 변동, 설명, 관련뉴스)
```

> **캐시 전략**: 조회했던 연/월 이벤트 데이터를 보관하여 탭 이동 시 직전 데이터를 먼저 표시하고, 새로 받은 응답이 준비되면 테이블을 교체합니다.

### 4.5 서버 API 데이터 흐름

```
[GET /api/daily/:year/:month]
    │
    ├─ validateYearMonth()
    ├─ getMonthRange()
    ├─ fetchAllHistorical()
    │   └─ 각 item → fetchChartFromYahoo()
    │         ├─ 캐시 확인 → hit 시 반환
    │         ├─ Yahoo Chart API HTTPS 호출 (User-Agent)
    │         ├─ JSON 파싱, sanitizeNum/sanitizeDate
    │         └─ 캐시 저장 (1시간 TTL)
    │
    └─ JSON { success, year, month, data, items, failed? }

[GET /api/update/:year/:month]
    │
    ├─ (daily와 유사)
    ├─ 현재월이면 end=오늘, 과거월이면 end=해당월 말일
    ├─ 월 범위로 데이터 필터
    └─ JSON { success, year, month, data, items, updatedAt, failed? }

[GET /api/events/:year/:month]
    │
    ├─ fetchAllHistorical()
    ├─ 후보 이벤트 (변동 3%+) 추출
    ├─ fetchNewsForSymbol() (Finnhub, newsSymbol 있는 항목만)
    ├─ 해당 날짜±1일 뉴스 있는 이벤트만 포함
    └─ JSON { success, year, month, events: {date: [ev]}, failed? }
```

---

## 5. 핵심 모듈 상세

### 5.1 server.js 주요 함수

| 함수 | 역할 |
|------|------|
| sanitizeNum(val) | NaN, Infinity, 비정상값 차단 |
| sanitizeDate(str) | YYYY-MM-DD 형식 검증 |
| isSymbolAllowed(sym) | 화이트리스트 검증 |
| fetchChartFromYahoo() | Yahoo Chart API 호출, 재시도 3회, 캐시 |
| fetchAllHistorical() | 19개 심볼 순차 조회, 500ms 간격 |
| fetchNewsForSymbol() | Finnhub company-news API |
| validateYearMonth() | year 2000~2100, month 1~12 |
| apiError() | 에러 응답 포맷 |

### 5.2 app.js 주요 함수

| 함수 | 역할 |
|------|------|
| escapeHtml(str) | XSS 방지 이스케이프 |
| showErrorPopup() | 에러 모달 표시 |
| loadTableData() | 테이블 데이터 로드 |
| renderTable() | 테이블 DOM 생성 |
| loadAllCharts() | 전체 차트 그리드 로드 |
| loadEvents() | 이벤트 데이터 로드 |
| renderEvents() | 이벤트 테이블 렌더링 |
| formatPrice() | 가격 포맷 (단위별) |

### 5.3 config/symbols.js 구조

```javascript
// 각 항목: id, name, symbol(Yahoo), unit, newsSymbol(Finnhub)
// symbol: ^KS11, AAPL, KRW=X 등
// newsSymbol: null 또는 Finnhub 심볼 (SPY, AAPL 등)
```

---

## 6. 보안 검증 체크리스트

| 항목 | 구현 위치 | 검증 |
|------|-----------|------|
| X-Content-Type-Options | server.js 미들웨어 | ✓ nosniff |
| X-XSS-Protection | server.js | ✓ 1; mode=block |
| Content-Security-Policy | server.js | ✓ 정의됨 |
| 심볼 화이트리스트 | fetchChartFromYahoo | ✓ SYMBOL_WHITELIST |
| 숫자 검증 | sanitizeNum | ✓ NaN, Infinity, 1e15 제한 |
| 날짜 검증 | sanitizeDate, validateYearMonth | ✓ |
| 응답 크기 제한 | fetchChartFromYahoo | ✓ 5MB |
| HTML 이스케이프 | app.js escapeHtml | ✓ 동적 출력 시 |

---

## 7. 파일 기반 월별 캐시

| 항목 | 설명 |
|------|------|
| 저장 경로 | `data/daily-cache.json` |
| 키 형식 | `YYYY-MM` (연-월) |
| 로드 | 서버 기동 시 자동 로드 |
| 저장 | Yahoo 조회 후 비동기 저장 (setImmediate) |

**동작**
- **일반 조회 (daily)**: 캐시에 해당 월이 있으면 즉시 반환, 없으면 Yahoo 조회 후 저장·반환
- **업데이트 (update)**: Yahoo 조회 후 기존 캐시와 병합(신규 날짜 추가·갱신), 저장 후 반환
- **이벤트 (events)**: daily와 동일한 캐시 사용

---

## 8. 외부 의존성

| 의존성 | 용도 |
|--------|------|
| Yahoo Finance Chart API | 일별 시세 (비공식) |
| Finnhub Company News API | 뉴스 기사 (이벤트 필터) |
| Chart.js (CDN) | 라인 차트 |
| dotenv | .env 환경변수 로드 |

---

## 9. 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| PORT | N | 서버 포트 (기본 3000) |
| FINNHUB_API_KEY | 뉴스용 | Finnhub API 키 (이벤트 메뉴) |

---

## 10. 코드 검증 시 확인 사항

1. **API 응답 형식**: `success`, `error`, `cause` 구조 준수
2. **날짜 형식**: YYYY-MM-DD 일관 사용
3. **에러 처리**: try-catch, apiError() 호출
4. **캐시 키**: `symbol:fromDate:toDate` 형식
5. **차트 색상**: RED, YELLOW, BLUE 조건 로직
6. **이벤트 필터**: newsSymbol + hasNewsOnDate 체크

---

*문서 버전: 1.0 | 최종 수정: 2025*
