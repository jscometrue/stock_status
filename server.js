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

// 뉴스 조회 (Finnhub) - 해당 항목 상승/하락 이유를 설명한 뉴스가 있을 때만 이벤트 포함
const newsCache = new Map();
const NEWS_CACHE_TTL = 30 * 60 * 1000; // 30분

async function fetchNewsForSymbol(symbol, fromDate, toDate, opts = {}) {
  const { skipCache = false } = opts;
  const key = `${symbol}:${fromDate}:${toDate}`;
  const cached = newsCache.get(key);
  if (!skipCache && cached && cached.expires > Date.now()) return cached.data;

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return [];

  const today = formatYMD(new Date());
  const toDateCapped = toDate > today ? today : toDate;
  const fromTs = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const toTs = Math.floor(new Date(toDateCapped + 'T23:59:59Z').getTime() / 1000);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fromTs}&to=${toTs}&token=${apiKey}`;

  try {
    const body = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    const parsed = JSON.parse(body || '[]');
    if (!Array.isArray(parsed)) {
      if (parsed && parsed.error) console.warn(`[Finnhub ${symbol}]`, parsed.error);
      return [];
    }
    const result = parsed.map(n => ({
      date: n.datetime ? new Date(n.datetime * 1000).toISOString().slice(0, 10) : null,
      headline: (n.headline || '').substring(0, 500)
    })).filter(n => n.date);
    newsCache.set(key, { data: result, expires: Date.now() + NEWS_CACHE_TTL });
    return result;
  } catch (err) {
    console.warn(`[뉴스 ${symbol}]`, err.message);
    return [];
  }
}

function findNewsForDate(newsList, eventDate) {
  if (!newsList || newsList.length === 0) return null;
  return newsList.find(n => n.date === eventDate || isAdjacentDate(n.date, eventDate)) || null;
}

const US_MARKET_NEWS_SYMBOLS = ['AAPL', 'NVDA', 'SPY', 'MSFT'];

function parseNewsItem(n) {
  const ts = n.datetime ?? n.publishedDate ?? n.date ?? n.time;
  const head = n.headline ?? n.title ?? n.summary ?? '';
  if (!head) return null;
  let sec = 0;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    sec = ts < 1e12 ? ts : Math.floor(ts / 1000);
  } else if (ts != null && ts !== '') {
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return null;
    sec = Math.floor(t / 1000);
  } else {
    return null;
  }
  const dt = new Date(sec * 1000);
  if (!Number.isFinite(dt.getTime())) return null;
  const dateStr = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  return { date: dateStr, headline: String(head).substring(0, 500) };
}

async function fetchMarketNews(fromDate, toDate, opts = {}) {
  const { skipCache = false } = opts;
  const key = `market:${fromDate}:${toDate}`;
  const cached = newsCache.get(key);
  if (!skipCache && cached && cached.expires > Date.now()) return cached.data;

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return [];

  const today = formatYMD(new Date());
  const toDateCapped = toDate > today ? today : toDate;
  const fromTs = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const toTs = Math.floor(new Date(toDateCapped + 'T23:59:59Z').getTime() / 1000);

  const allNews = [];

  const tryMarketNews = async (path = 'market-news') => {
    try {
      const url = `https://finnhub.io/api/v1/${path}?category=general&token=${apiKey}`;
      const body = await new Promise((resolve, reject) => {
        https.get(url, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      const parsed = JSON.parse(body || '[]');
      if (!Array.isArray(parsed)) return;
      for (const n of parsed) {
        const item = parseNewsItem(n);
        if (item) {
          if (item.date >= fromDate && item.date <= toDateCapped) {
            allNews.push(item);
          }
        }
      }
    } catch (err) {
      console.warn('[Finnhub market-news]', err.message);
    }
  };

  await tryMarketNews('market-news');
  if (allNews.length === 0) await tryMarketNews('news');

  if (allNews.length === 0) {
    for (const symbol of US_MARKET_NEWS_SYMBOLS) {
      try {
        const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fromTs}&to=${toTs}&token=${apiKey}`;
        const body = await new Promise((resolve, reject) => {
          https.get(url, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
          }).on('error', reject);
        });
        const parsed = JSON.parse(body || '[]');
        if (!Array.isArray(parsed)) {
          if (parsed && parsed.error) console.warn(`[Finnhub ${symbol}]`, parsed.error);
          continue;
        }
        for (const n of parsed) {
          const item = parseNewsItem(n);
          if (item) allNews.push(item);
        }
        await delay(150);
      } catch (err) {
        console.warn(`[미국시장 뉴스 ${symbol}]`, err.message);
      }
    }
  }

  const seen = new Set();
  const result = allNews.filter(n => {
    const k = `${n.date}:${n.headline}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  newsCache.set(key, { data: result, expires: Date.now() + NEWS_CACHE_TTL });
  if (result.length > 0) console.log(`[뉴스] ${fromDate}~${toDateCapped}: ${result.length}건`);
  return result;
}

function buildMarketNewsByDate(marketNewsList) {
  const byDate = new Map();
  if (!marketNewsList || marketNewsList.length === 0) return byDate;
  for (const n of marketNewsList) {
    if (!byDate.has(n.date)) byDate.set(n.date, []);
    byDate.get(n.date).push(n.headline);
  }
  return byDate;
}

function getMarketHeadlineForDate(marketByDate, eventDate) {
  const exact = marketByDate.get(eventDate);
  if (exact && exact.length > 0) return exact[0];
  let best = null;
  let bestDiff = Infinity;
  const maxDays = 14;
  for (const [d, headlines] of marketByDate) {
    if (headlines.length === 0) continue;
    const diff = Math.abs(new Date(d).getTime() - new Date(eventDate).getTime()) / (24 * 60 * 60 * 1000);
    if (diff <= maxDays && diff < bestDiff) {
      best = headlines[0];
      bestDiff = diff;
    }
  }
  return best;
}

function isAdjacentDate(d1, d2) {
  const a = new Date(d1).getTime();
  const b = new Date(d2).getTime();
  const diff = Math.abs(a - b) / (24 * 60 * 60 * 1000);
  return diff <= 2;
}

// 과거 추이·향후 시장 분석 기반 매도 시점 경고 메시지 생성
function getSellTimingWarning(data, evtDate, changePct, type) {
  if (!data || data.length < 2) return '-';
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const closes = sorted.map(d => d.close).filter(v => v != null);
  if (closes.length < 2) return '-';

  const idx = sorted.findIndex(d => d.date === evtDate);
  if (idx < 0 || idx >= closes.length) return '-';

  const curr = closes[idx];
  const monthFirst = closes[0];
  const monthHigh = Math.max(...closes.slice(0, idx + 1));
  const monthLow = Math.min(...closes.slice(0, idx + 1));

  let consecDown = 0;
  for (let i = idx; i >= 1; i--) {
    if (closes[i] < closes[i - 1]) consecDown++; else break;
  }

  const cumulChange = ((curr - monthFirst) / monthFirst) * 100;
  const fromHigh = ((curr - monthHigh) / monthHigh) * 100;

  const isDrop = type === '하락';
  const isRise = type === '상승';

  if (isDrop) {
    if (changePct <= -7 && consecDown >= 2) return '⚠ 급락 구간 - 즉시 매도 검토 권고';
    if (changePct <= -5 && consecDown >= 2) return '⚠ 하락 추세 지속 - 매도 시점 검토 권고';
    if (cumulChange <= -5 && fromHigh <= -5) return '⚠ 월간 손실 확대 - 손절 포인트 검토';
    if (consecDown >= 3) return '△ 연속 하락 - 관망 또는 분할 매도 고려';
    if (changePct <= -5) return '△ 단기 급락 - 추가 하락 시 매도 검토';
    if (cumulChange <= -3) return '△ 월 누적 하락 - 보유 비중 점검';
    return '○ 변동성 확대 - 시장 모니터링';
  }

  if (isRise) {
    if (changePct >= 7) return '○ 급등 - 일부 익절 검토';
    if (fromHigh >= -1 && changePct >= 5) return '○ 고점 근접 - 수익 실현 고려';
    return '○ 상승 지속 - 보유 유지';
  }

  return '-';
}

// API: 이벤트/뉴스 - 상승/하락 이유를 설명한 뉴스가 있는 경우만 포함 (캐시 사용, ?refresh=1 시 최신 반영)
app.get('/api/events/:year/:month', async (req, res) => {
  try {
    const vm = validateYearMonth(req.params.year, req.params.month);
    if (!vm) {
      return apiError(res, 400, '잘못된 날짜 범위', '년(2000~2100), 월(1~12)을 확인하세요');
    }
    const forceRefresh = req.query.refresh === '1';
    const { data: raw, failed } = await getMonthlyData(vm.year, vm.month, { forceRefresh });
    const { start, end } = getMonthRange(vm.year, vm.month);
    const monthStart = formatYMD(start);
    const monthEnd = formatYMD(end);

    const candidateEvents = [];
    for (const item of getEffectiveItems()) {
      const data = raw[item.id] || [];
      for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1].close;
        const curr = data[i].close;
        if (prev == null || curr == null || prev === 0) continue;
        const changePct = ((curr - prev) / prev) * 100;
        if (Math.abs(changePct) >= 3) {
          candidateEvents.push({
            date: data[i].date,
            item: item.name,
            itemObj: item,
            change: changePct,
            type: changePct > 0 ? '상승' : '하락',
            description: `${item.name} 전일대비 ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`
          });
        }
      }
    }

    const marketNews = await fetchMarketNews(monthStart, monthEnd, { skipCache: forceRefresh });
    const marketByDate = buildMarketNewsByDate(marketNews);

    const events = [];
    for (const ev of candidateEvents) {
      const newsSym = ev.itemObj.newsSymbol;
      if (!newsSym) continue;
      const marketHeadline = getMarketHeadlineForDate(marketByDate, ev.date);
      const itemData = raw[ev.itemObj.id] || [];
      const sellWarning = getSellTimingWarning(itemData, ev.date, ev.change, ev.type);
      events.push({
        date: ev.date,
        item: ev.item,
        change: ev.change,
        type: ev.type,
        description: ev.description,
        newsHeadline: marketHeadline,
        sellWarning
      });
    }

    const byDate = {};
    events.forEach(e => {
      if (!byDate[e.date]) byDate[e.date] = [];
      byDate[e.date].push(e);
    });

    res.json({
      success: true,
      year: vm.year,
      month: vm.month,
      events: byDate,
      failed: failed.length > 0 ? failed : undefined,
      newsFilterApplied: false
    });
  } catch (err) {
    console.error('events API:', err);
    apiError(res, 500, '이벤트 조회 중 오류 발생', err.message);
  }
});

// API: 뉴스 (샘플 - 실제 뉴스 API 연동 시 교체)
app.get('/api/news/:date', (req, res) => {
  const { date } = req.params;
  // 샘플 뉴스 - 실제로는 뉴스 API 사용
  const sampleNews = [
    { date, title: '미국 Fed 금리 결정 관련 시장 주목', source: 'Sample', type: 'market' },
    { date, title: '한국증시, 외국인 매수 지속', source: 'Sample', type: 'korea' },
  ];
  res.json({ date, news: sampleNews });
});

// API: 심볼 목록 (오버라이드 반영)
app.get('/api/symbols', (req, res) => {
  res.json({ items: getEffectiveItems() });
});

// 한글 종목명 → Yahoo 검색용 영문/심볼 fallback (한글 검색 4xx 시 재시도)
const SEARCH_FALLBACK_KO = {
  '삼성전자': 'Samsung Electronics',
  '삼성전자주식': 'Samsung Electronics',
  '현대자동차': 'Hyundai Motor',
  '현대차': 'Hyundai Motor',
  'sk하이닉스': 'SK Hynix',
  '엔비디아': 'NVIDIA',
  '앤비디아': 'NVIDIA',
  '애플': 'Apple',
  '테슬라': 'Tesla',
  '네이버': 'Naver',
  '카카오': 'Kakao',
  'lg에너지솔루션': 'LG Energy Solution',
  '기아': 'Kia',
  '삼성바이오로직스': 'Samsung Biologics',
  '삼성sdi': 'Samsung SDI',
  '삼성엔지니어링': 'Samsung E&C',
  'kb금융': 'KB Financial',
  '신한지주': 'Shinhan Financial',
  '포스코홀딩스': 'POSCO Holdings',
  '셀트리온': 'Celltrion',
  '삼성생명': 'Samsung Life Insurance',
  '한국전력': 'Korea Electric Power',
  'lg전자': 'LG Electronics',
  '삼성물산': 'Samsung C&T',
  'naver': 'Naver',
  'kakao': 'Kakao'
};

function normalizeSearchFallbackKey(str) {
  return (str || '').trim().replace(/\s+/g, '').toLowerCase();
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

// Yahoo Finance 종목 검색 (한글 입력 시 fallback으로 영문 재시도)
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
  const fallback = key && SEARCH_FALLBACK_KO[key];
  if (fallback) {
    try {
      list = await fetchYahooSearch(fallback);
    } catch (e) {
      console.warn('symbol search fallback:', e.message);
    }
  }
  return list;
}

// API: 종목 검색 (이름 또는 코드로 유사 항목 조회) — 항상 200, 404 미반환
app.get('/api/symbols/search', async (req, res) => {
  try {
    const q = (req.query.q || req.query.query || '').trim();
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
