require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const { items } = require('./config/symbols');

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'daily-cache.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'symbol-overrides.json');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;

// 항목별 심볼 오버라이드 (id -> { symbol, name? })
let symbolOverrides = {};

async function loadSymbolOverrides() {
  try {
    const buf = await fs.readFile(OVERRIDES_FILE, 'utf8');
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed === 'object') symbolOverrides = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('심볼 오버라이드 로드 실패:', e.message);
  }
}

function getEffectiveItems() {
  return items.map((item) => {
    const o = symbolOverrides[item.id];
    if (o && o.symbol) {
      return { ...item, symbol: o.symbol, name: o.name || item.name, overridden: true };
    }
    return { ...item, overridden: false };
  });
}

// 허용 심볼: 기본 목록 + 오버라이드 반영
function isSymbolAllowed(symbol) {
  if (typeof symbol !== 'string') return false;
  return getEffectiveItems().some((i) => i.symbol === symbol);
}
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const SAFE_NUM_MAX = 1e15;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// 보안 헤더
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 안전한 숫자 검증 (NaN, Infinity, 비정상 값 차단)
function sanitizeNum(val) {
  if (val == null) return null;
  const n = Number(val);
  if (!Number.isFinite(n) || Math.abs(n) > SAFE_NUM_MAX) return null;
  return n;
}

// 안전한 날짜 검증 (YYYY-MM-DD)
function sanitizeDate(str) {
  if (typeof str !== 'string') return null;
  if (!DATE_REGEX.test(str)) return null;
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return str;
}

// 날짜 유틸리티 (로컬 시간 기준)
function getMonthRange(year, month) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return { start, end };
}

function formatYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toTimestamp(d) {
  return Math.floor(d.getTime() / 1000);
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// 캐시: { key: { data, expires } }
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1시간

function getCacheKey(symbol, p1, p2) {
  return `${symbol}:${p1}:${p2}`;
}

// Yahoo Chart API 직접 호출 (User-Agent로 rate limit 완화, 응답 검증)
async function fetchChartFromYahoo(symbol, period1, period2) {
  if (!isSymbolAllowed(symbol)) {
    throw new Error(`허용되지 않은 심볼: ${symbol}`);
  }

  const p1 = formatYMD(period1);
  const p2 = formatYMD(period2);
  const t1 = toTimestamp(period1);
  let t2 = toTimestamp(period2);
  if (t1 >= t2) t2 = t1 + 86400;

  const cacheKey = getCacheKey(symbol, p1, p2);
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${t1}&period2=${t2}&interval=1d&events=`;
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  for (let retry = 0; retry < 3; retry++) {
    try {
      const html = await new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: { 'User-Agent': ua }
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_RESPONSE_SIZE) {
              req.destroy();
              reject(new Error('응답 크기 초과'));
            }
          });
          res.on('end', () => {
            if (res.statusCode === 429 || body.includes('Too Many Requests')) {
              reject(new Error('RATE_LIMITED'));
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            resolve(body);
          });
        });
        req.on('error', (e) => reject(new Error(e.message || '네트워크 오류')));
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('TIMEOUT')); });
      });

      let json;
      try {
        json = JSON.parse(html);
      } catch {
        throw new Error('잘못된 응답 형식');
      }

      const chart = json?.chart?.result?.[0];
      if (!chart || !Array.isArray(chart.timestamp)) {
        cache.set(cacheKey, { data: [], expires: Date.now() + CACHE_TTL });
        return [];
      }

      const quote = chart.indicators?.quote?.[0] || {};
      const result = [];
      for (let i = 0; i < chart.timestamp.length; i++) {
        const ts = chart.timestamp[i];
        if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
        const d = new Date(ts * 1000);
        const dateStr = formatYMD(d);
        if (!sanitizeDate(dateStr)) continue;
        const close = sanitizeNum(quote.close?.[i]);
        if (close == null) continue;
        result.push({
          date: dateStr,
          close,
          open: sanitizeNum(quote.open?.[i]),
          high: sanitizeNum(quote.high?.[i]),
          low: sanitizeNum(quote.low?.[i]),
          volume: sanitizeNum(quote.volume?.[i])
        });
      }

      cache.set(cacheKey, { data: result, expires: Date.now() + CACHE_TTL });
      return result;
    } catch (err) {
      const wait = (retry + 1) * 2000;
      console.warn(`[${symbol}] 시도 ${retry + 1}/3 실패:`, err.message);
      await delay(wait);
    }
  }
  throw new Error('데이터 조회 실패');
}

// 심볼 검증용: 화이트리스트 없이 Yahoo에서 1일 차트 조회 후 meta 반환
async function fetchYahooChartMeta(symbol) {
  if (!symbol || typeof symbol !== 'string') throw new Error('심볼을 입력하세요');
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 5);
  const t1 = toTimestamp(start);
  const t2 = toTimestamp(end);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${t1}&period2=${t2}&interval=1d&events=`;
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const html = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': ua } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
  const json = JSON.parse(html);
  const chart = json?.chart?.result?.[0];
  if (!chart || !Array.isArray(chart.timestamp) || chart.timestamp.length === 0) {
    throw new Error('해당 종목 데이터를 찾을 수 없습니다');
  }
  const meta = chart.meta || {};
  return {
    symbol: meta.symbol || symbol,
    shortName: meta.shortName || meta.longName || symbol,
    longName: meta.longName || meta.shortName || symbol
  };
}

// 일별 데이터 조회 (에러 시 빈 배열 반환, 에러 메시지 반환)
async function fetchHistoricalData(symbol, period1, period2) {
  try {
    return await fetchChartFromYahoo(symbol, period1, period2);
  } catch (err) {
    console.warn(`[${symbol}]`, err.message);
    return [];
  }
}

// 여러 심볼 순차 조회, 실패 목록 반환
async function fetchAllHistorical(items, start, end) {
  const results = {};
  const failed = [];
  for (const item of items) {
    try {
      results[item.id] = await fetchChartFromYahoo(item.symbol, start, end);
    } catch (err) {
      results[item.id] = [];
      failed.push({ name: item.name, reason: err.message });
    }
    await delay(500);
  }
  return { results, failed };
}

// 에러 메시지 사용자 친화적 변환
function toUserFriendlyCause(errMsg) {
  if (errMsg === 'RATE_LIMITED') return '데이터 제공처 요청 한도 초과. 잠시 후 다시 시도해 주세요.';
  if (errMsg === 'TIMEOUT') return '데이터 제공처 응답 지연. 잠시 후 다시 시도해 주세요.';
  if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ENOTFOUND')) return '외부 서버 연결 실패. 네트워크를 확인해 주세요.';
  if (errMsg.includes('응답 크기')) return '데이터 양이 비정상적으로 큽니다.';
  return errMsg;
}

// API 에러 응답
function apiError(res, code, message, cause) {
  res.status(code >= 500 ? 500 : 400).json({
    success: false,
    error: message,
    cause: cause ? toUserFriendlyCause(cause) : null
  });
}

// 연/월 검증
function validateYearMonth(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (isNaN(y) || isNaN(m) || y < 2000 || y > 2100 || m < 1 || m > 12) {
    return null;
  }
  return { year: y, month: m };
}

// 파일 기반 월별 데이터 캐시 (동일 날짜 재조회 시 즉시 응답)
const dailyFileCache = {};
let cacheSaveScheduled = false;

function getPeriodKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function loadDailyCacheFromFile() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const buf = await fs.readFile(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed === 'object') {
      Object.assign(dailyFileCache, parsed);
      console.log(`캐시 로드: ${Object.keys(dailyFileCache).length}개 월별 데이터`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('캐시 로드 실패:', e.message);
  }
}

function scheduleSaveDailyCache() {
  if (cacheSaveScheduled) return;
  cacheSaveScheduled = true;
  setImmediate(async () => {
    cacheSaveScheduled = false;
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(CACHE_FILE, JSON.stringify(dailyFileCache, null, 0), 'utf8');
    } catch (e) {
      console.warn('캐시 저장 실패:', e.message);
    }
  });
}

function getCachedMonthly(year, month) {
  const key = getPeriodKey(year, month);
  const entry = dailyFileCache[key];
  if (!entry || !entry.data) return null;
  return { year: entry.year, month: entry.month, data: entry.data };
}

function mergeMonthlyData(existing, fresh) {
  const merged = {};
  for (const id of Object.keys(existing)) {
    const byDate = new Map();
    (existing[id] || []).forEach(d => byDate.set(d.date, d));
    (fresh[id] || []).forEach(d => byDate.set(d.date, d));
    merged[id] = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  for (const id of Object.keys(fresh)) {
    if (merged[id]) continue;
    merged[id] = (fresh[id] || []).sort((a, b) => a.date.localeCompare(b.date));
  }
  return merged;
}

async function getMonthlyData(year, month, options = {}) {
  const { forceRefresh = false } = options;
  const monthStart = formatYMD(new Date(year, month - 1, 1));
  const now = new Date();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const endDate = isCurrentMonth ? now : new Date(year, month, 0);
  const monthEnd = formatYMD(endDate);

  const key = getPeriodKey(year, month);
  const cached = getCachedMonthly(year, month);
  if (cached && !forceRefresh) {
    return { data: cached.data, failed: [] };
  }

  const { start, end } = getMonthRange(year, month);
  const rangeEnd = isCurrentMonth ? now : end;
  const { results: raw, failed } = await fetchAllHistorical(getEffectiveItems(), start, rangeEnd);

  const results = {};
  for (const id of Object.keys(raw)) {
    results[id] = (raw[id] || [])
      .filter(d => sanitizeDate(d.date) && d.date >= monthStart && d.date <= monthEnd)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  let toSave = results;
  if (forceRefresh && cached && cached.data) {
    toSave = mergeMonthlyData(cached.data, results);
  }
  dailyFileCache[key] = { year, month, data: toSave, updatedAt: new Date().toISOString() };
  scheduleSaveDailyCache();

  return { data: toSave, failed };
}

// API: 월별 일별 데이터 (캐시 우선, 미존재 시 Yahoo 조회 후 저장)
app.get('/api/daily/:year/:month', async (req, res) => {
  try {
    const vm = validateYearMonth(req.params.year, req.params.month);
    if (!vm) {
      return apiError(res, 400, '잘못된 날짜 범위', '년(2000~2100), 월(1~12)을 확인하세요');
    }
    const { data, failed } = await getMonthlyData(vm.year, vm.month);
    res.json({
      success: true,
      year: vm.year,
      month: vm.month,
      data,
      items: getEffectiveItems(),
      failed: failed.length > 0 ? failed : undefined
    });
  } catch (err) {
    console.error('daily API:', err);
    apiError(res, 500, '데이터 조회 중 오류 발생', err.message);
  }
});

// API: 최근 N일 일별 데이터 (기본 30일, 오늘 기준 이전 N일: 어제까지)
// 기존 /api/daily/:year/:month 라우트와 경로 충돌을 피하기 위해 daily_recent로 분리
app.get('/api/daily_recent/:days?', async (req, res) => {
  try {
    const rawDays = parseInt(req.params.days || '30', 10);
    const days = isNaN(rawDays) ? 30 : Math.min(Math.max(rawDays, 1), 365);

    // 오늘 0시 기준으로 어제까지 N일 구간 계산
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(today);
    end.setDate(today.getDate() - 1); // 어제
    const start = new Date(end);
    start.setDate(end.getDate() - (days - 1));

    const from = formatYMD(start);
    const to = formatYMD(end);

    const { results: raw, failed } = await fetchAllHistorical(getEffectiveItems(), start, end);
    const data = {};
    for (const id of Object.keys(raw)) {
      data[id] = (raw[id] || [])
        .filter(d => sanitizeDate(d.date) && d.date >= from && d.date <= to)
        .sort((a, b) => a.date.localeCompare(b.date));
    }

    res.json({
      success: true,
      from,
      to,
      days,
      data,
      items: getEffectiveItems(),
      failed: failed.length > 0 ? failed : undefined
    });
  } catch (err) {
    console.error('daily recent API:', err);
    apiError(res, 500, '최근 일별 데이터 조회 중 오류 발생', err.message);
  }
});

// API: 특정 심볼 월별 데이터 (차트용)
app.get('/api/chart/:symbol/:year/:month', async (req, res) => {
  try {
    const vm = validateYearMonth(req.params.year, req.params.month);
    if (!vm) {
      return apiError(res, 400, '잘못된 날짜 범위', '년(2000~2100), 월(1~12)을 확인하세요');
    }
    const { symbol } = req.params;
    const item = getEffectiveItems().find(i => i.id === symbol || i.symbol === symbol);
    const sym = item ? item.symbol : symbol;
    if (!isSymbolAllowed(sym)) {
      return apiError(res, 400, '허용되지 않은 항목', `항목을 선택해 주세요`);
    }
    const { start, end } = getMonthRange(vm.year, vm.month);
    const data = await fetchChartFromYahoo(sym, start, end);
    res.json({
      success: true,
      symbol: item?.name || symbol,
      data: data.map(d => ({ date: d.date, close: d.close, open: d.open }))
    });
  } catch (err) {
    console.error('chart API:', err);
    apiError(res, 500, '차트 데이터 조회 실패', err.message);
  }
});

// API: 업데이트 - 신규 날짜만 Yahoo 조회 후 캐시에 병합 저장
app.get('/api/update/:year/:month', async (req, res) => {
  try {
    const vm = validateYearMonth(req.params.year, req.params.month);
    if (!vm) {
      return apiError(res, 400, '잘못된 날짜 범위', '년(2000~2100), 월(1~12)을 확인하세요');
    }
    const { data, failed } = await getMonthlyData(vm.year, vm.month, { forceRefresh: true });
    res.json({
      success: true,
      year: vm.year,
      month: vm.month,
      data,
      items: getEffectiveItems(),
      updatedAt: new Date().toISOString(),
      failed: failed.length > 0 ? failed : undefined
    });
  } catch (err) {
    console.error('update API:', err);
    apiError(res, 500, '업데이트 중 오류 발생', err.message);
  }
});

// API: 심볼 목록 (오버라이드 반영)
app.get('/api/symbols', (req, res) => {
  res.json({ items: getEffectiveItems() });
});

// 한글 종목명 → Yahoo 검색용 영문/심볼 fallback (한글 검색 실패 시 재시도)
// 키: 정규화된 검색어, 값: 시도할 검색어 배열 (순서대로 시도)
const SEARCH_FALLBACK_KO = {
  '삼성전자': ['Samsung Electronics', '005930.KS'],
  '삼성전자주식': ['Samsung Electronics', '005930.KS'],
  '삼성': ['Samsung Electronics', 'Samsung'],
  '현대자동차': ['Hyundai Motor', '005380.KS'],
  '현대차': ['Hyundai Motor', '005380.KS'],
  'sk하이닉스': ['SK Hynix', '000660.KS'],
  '엔비디아': ['NVIDIA'],
  '앤비디아': ['NVIDIA'],
  '애플': ['Apple', 'AAPL'],
  '테슬라': ['Tesla', 'TSLA'],
  '네이버': ['Naver', '035420.KS'],
  '카카오': ['Kakao', '035720.KS'],
  'lg에너지솔루션': ['LG Energy Solution'],
  '기아': ['Kia', '000270.KS'],
  '삼성바이오로직스': ['Samsung Biologics'],
  '삼성sdi': ['Samsung SDI'],
  '삼성엔지니어링': ['Samsung E&C'],
  'kb금융': ['KB Financial'],
  '신한지주': ['Shinhan Financial'],
  '포스코홀딩스': ['POSCO Holdings'],
  '셀트리온': ['Celltrion'],
  '삼성생명': ['Samsung Life Insurance'],
  '한국전력': ['Korea Electric Power'],
  'lg전자': ['LG Electronics'],
  '삼성물산': ['Samsung C&T'],
  'naver': ['Naver'],
  'kakao': ['Kakao'],
  '팔란티어': ['Palantir', 'PLTR'],
  '팔란티어테크놀로지': ['Palantir', 'PLTR']
};

function normalizeSearchFallbackKey(str) {
  return (str || '').trim().replace(/\s+/g, '').toLowerCase();
}

// 한글(완성형) 포함 여부
function hasHangul(str) {
  return /[\uac00-\ud7a3]/.test(str || '');
}

// 한글 → 영어 번역 (MyMemory 무료 API, API 키 불필요)
async function translateKoToEn(text) {
  const t = (text || '').trim();
  if (!t || !hasHangul(t)) return null;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(t)}&langpair=ko|en`;
  try {
    const html = await new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StockDashboard/1.0)' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
      });
      req.on('error', reject);
      req.setTimeout(6000, () => { req.destroy(); reject(new Error('TIMEOUT')); });
    });
    const json = JSON.parse(html);
    const translated = json?.responseData?.translatedText;
    if (translated && typeof translated === 'string') {
      const out = translated.trim();
      if (out && out !== t) return out;
    }
  } catch (e) {
    console.warn('translate Ko→En:', e.message);
  }
  return null;
}

// 한글 포함 시 사용할 fallback 후보 반환 (정확 매칭 + 포함 매칭)
function getFallbackTerms(normalizedKey) {
  if (!normalizedKey) return [];
  const exact = SEARCH_FALLBACK_KO[normalizedKey];
  if (exact) return Array.isArray(exact) ? exact : [exact];
  const out = [];
  if (normalizedKey.includes('삼성전자')) out.push('Samsung Electronics', '005930.KS');
  else if (normalizedKey.includes('삼성')) out.push('Samsung Electronics', 'Samsung');
  if (normalizedKey.includes('현대차') || normalizedKey.includes('현대자동차')) out.push('Hyundai Motor', '005380.KS');
  if (normalizedKey.includes('네이버')) out.push('Naver', '035420.KS');
  if (normalizedKey.includes('카카오')) out.push('Kakao', '035720.KS');
  if (normalizedKey.includes('엔비디아') || normalizedKey.includes('앤비디아')) out.push('NVIDIA');
  if (normalizedKey.includes('애플')) out.push('Apple', 'AAPL');
  if (normalizedKey.includes('테슬라')) out.push('Tesla', 'TSLA');
  if (normalizedKey.includes('알파벳')) out.push('Alphabet', 'GOOGL');
  if (normalizedKey.includes('마이크로소프트')) out.push('Microsoft', 'MSFT');
  if (normalizedKey.includes('아마존')) out.push('Amazon', 'AMZN');
  if (normalizedKey.includes('메타')) out.push('Meta', 'META');
  if (normalizedKey.includes('팔란티어')) out.push('Palantir', 'PLTR');
  return out;
}

async function fetchYahooSearch(query) {
  const q = (query || '').trim();
  if (!q) return [];
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0`;
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const maxBody = 512 * 1024;
  const html = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': ua } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > maxBody) {
          req.destroy();
          reject(new Error('응답 크기 초과'));
        }
      });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
  let json;
  try {
    json = JSON.parse(html);
  } catch {
    return [];
  }
  const quotes = json?.quotes || [];
  return quotes
    .filter((x) => x.symbol && (x.shortname || x.longname))
    .map((x) => ({
      symbol: x.symbol,
      name: (x.shortname || x.longname || x.symbol).trim(),
      exchange: x.exchangeDisp || x.exchange || ''
    }));
}

// Yahoo Finance 종목 검색 (한글 입력 시 사전 fallback → 번역 후 영문 검색)
async function searchYahooSymbols(query) {
  const q = (query || '').trim();
  if (!q || q.length < 2) return [];
  let list = [];
  try {
    list = await fetchYahooSearch(q);
  } catch (err) {
    console.warn('symbol search first try:', err.message);
  }
  if (list.length > 0) return list;
  const key = normalizeSearchFallbackKey(q);
  const fallbackTerms = getFallbackTerms(key);
  for (const term of fallbackTerms) {
    try {
      list = await fetchYahooSearch(term);
      if (list.length > 0) return list;
    } catch (e) {
      console.warn('symbol search fallback:', term, e.message);
    }
  }
  if (hasHangul(q)) {
    const translated = await translateKoToEn(q);
    if (translated) {
      try {
        list = await fetchYahooSearch(translated);
        if (list.length > 0) return list;
      } catch (e) {
        console.warn('symbol search after translate:', e.message);
      }
    }
  }
  return list;
}

// API: 종목 검색 (이름 또는 코드로 유사 항목 조회) — 항상 200, 404 미반환
app.get('/api/symbols/search', async (req, res) => {
  try {
    let q = (req.query.q || req.query.query || '').trim();
    q = q.replace(/[\u200b-\u200f\ufeff]/g, '').trim();
    if (!q) {
      return res.json({ suggestions: [] });
    }
    const suggestions = await searchYahooSymbols(q);
    res.json({ suggestions });
  } catch (err) {
    console.warn('symbol search:', err.message);
    res.json({ suggestions: [] });
  }
});

// API: 심볼 검증 (Yahoo 존재 여부 + 종목 정보)
app.get('/api/symbols/validate', async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').trim().toUpperCase();
    if (!symbol) {
      return res.status(400).json({ success: false, valid: false, error: '심볼을 입력하세요' });
    }
    const meta = await fetchYahooChartMeta(symbol);
    res.json({
      success: true,
      valid: true,
      symbol: meta.symbol,
      name: meta.shortName || meta.longName || meta.symbol
    });
  } catch (err) {
    res.json({
      success: true,
      valid: false,
      error: err.message || '종목을 확인할 수 없습니다'
    });
  }
});

// API: 항목을 다른 종목으로 변경 (오버라이드 저장)
app.post('/api/symbols/override', async (req, res) => {
  try {
    const { id, symbol: newSymbol, name: newName } = req.body || {};
    const sym = (newSymbol || '').trim();
    if (!id || !sym) {
      return res.status(400).json({ success: false, error: '항목 id와 변경할 심볼을 입력하세요' });
    }
    const base = items.find((i) => i.id === id);
    if (!base) {
      return res.status(400).json({ success: false, error: '존재하지 않는 항목입니다' });
    }
    const meta = await fetchYahooChartMeta(sym);
    await fs.mkdir(DATA_DIR, { recursive: true });
    symbolOverrides[id] = { symbol: meta.symbol || sym, name: (newName || meta.shortName || meta.longName || sym).trim() };
    await fs.writeFile(OVERRIDES_FILE, JSON.stringify(symbolOverrides, null, 2), 'utf8');
    res.json({ success: true, items: getEffectiveItems() });
  } catch (err) {
    console.error('override API:', err);
    res.status(400).json({ success: false, error: err.message || '변경에 실패했습니다' });
  }
});

// API: 항목 오버라이드 제거 (원래 종목으로 복원)
app.delete('/api/symbols/override/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!items.some((i) => i.id === id)) {
      return res.status(400).json({ success: false, error: '존재하지 않는 항목입니다' });
    }
    delete symbolOverrides[id];
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(OVERRIDES_FILE, JSON.stringify(symbolOverrides, null, 2), 'utf8');
    res.json({ success: true, items: getEffectiveItems() });
  } catch (err) {
    console.error('override delete API:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await loadDailyCacheFromFile();
  await loadSymbolOverrides();
  app.listen(PORT, () => {
    console.log(`서버 실행: http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('시작 실패:', err);
  process.exit(1);
});
