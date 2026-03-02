const API = '/api';
let currentData = null;
let priceCharts = [];
const makePeriodKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
const dailyCache = new Map();
const eventsCache = new Map();
let lastRenderedChartKey = null;
let lastRenderedEventsKey = null;
let chartRequestToken = null;
let eventsRequestToken = null;

// XSS 방지: HTML 이스케이프
function escapeHtml(str) {
  if (str == null || typeof str !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const formatChangePct = (value) => {
  if (value == null || !Number.isFinite(value)) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
};

const getCurrentConsecDownDays = (series) => {
  if (!Array.isArray(series)) return 0;
  let consec = 0;
  for (let i = series.length - 1; i >= 1; i--) {
    if (series[i] < series[i - 1]) consec++;
    else break;
  }
  return consec;
};

const calcDropFromHighPct = (series) => {
  if (!Array.isArray(series) || series.length === 0) return 0;
  const last = series[series.length - 1];
  const monthHigh = Math.max(...series);
  if (!Number.isFinite(last) || !Number.isFinite(monthHigh) || monthHigh === 0) return 0;
  return ((last - monthHigh) / monthHigh) * 100;
};

const calcMonthChangePct = (series) => {
  if (!Array.isArray(series) || series.length === 0) return null;
  const first = series[0];
  const last = series[series.length - 1];
  if (!Number.isFinite(first) || first === 0 || !Number.isFinite(last)) return null;
  return ((last - first) / first) * 100;
};

// RSI(2): 2일 기준 상대강도지수 (최근 3일 종가로 마지막 RSI 계산)
function calcRSI2(closes) {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  const n = closes.length;
  const c0 = Number(closes[n - 3]);
  const c1 = Number(closes[n - 2]);
  const c2 = Number(closes[n - 1]);
  if (!Number.isFinite(c0) || !Number.isFinite(c1) || !Number.isFinite(c2)) return null;
  const ch1 = c1 - c0;
  const ch2 = c2 - c1;
  const gain1 = ch1 > 0 ? ch1 : 0;
  const loss1 = ch1 < 0 ? -ch1 : 0;
  const gain2 = ch2 > 0 ? ch2 : 0;
  const loss2 = ch2 < 0 ? -ch2 : 0;
  const avgGain = (gain1 + gain2) / 2;
  const avgLoss = (loss1 + loss2) / 2;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// RSI(2) 기준 매매 신호 (정리된 전략: 10/30/70/90)
function getRSISignal(rsi) {
  if (rsi == null || !Number.isFinite(rsi)) return { label: null, className: 'rsi-neutral' };
  if (rsi <= 10) return { label: '강력매수', className: 'rsi-strong-buy' };
  if (rsi < 30) return { label: '매수', className: 'rsi-buy' };
  if (rsi >= 90) return { label: '강력매도', className: 'rsi-strong-sell' };
  if (rsi > 70) return { label: '매도', className: 'rsi-sell' };
  return { label: '보합', className: 'rsi-neutral' };
}

// 에러 팝업 표시
function showErrorPopup(title, message, cause) {
  const overlay = document.getElementById('errorPopup');
  document.getElementById('errorPopupTitle').textContent = escapeHtml(title);
  document.getElementById('errorPopupMessage').textContent = escapeHtml(message);
  const causeEl = document.getElementById('errorPopupCause');
  causeEl.textContent = cause ? escapeHtml(cause) : '';
  causeEl.style.display = cause ? 'block' : 'none';
  overlay.classList.add('visible');
}

function hideErrorPopup() {
  document.getElementById('errorPopup').classList.remove('visible');
}

// 현재 연도/월
const now = new Date();
let currentYear = now.getFullYear();
let currentMonth = now.getMonth() + 1;
const isTabActive = (tab) => document.querySelector(`.tab[data-tab="${tab}"]`).classList.contains('active');

function initSelectors() {
  const yearSelect = document.getElementById('yearSelect');
  const monthSelect = document.getElementById('monthSelect');

  for (let y = now.getFullYear(); y >= now.getFullYear() - 5; y--) {
    yearSelect.appendChild(new Option(`${y}년`, y));
  }
  for (let m = 1; m <= 12; m++) {
    monthSelect.appendChild(new Option(`${m}월`, m));
  }

  yearSelect.value = currentYear;
  monthSelect.value = currentMonth;

  const onPeriodChange = () => {
    currentYear = parseInt(yearSelect.value);
    currentMonth = parseInt(monthSelect.value);
    loadTableData();
    if (isTabActive('chart')) loadAllCharts();
    if (isTabActive('events')) loadEvents(false);
  };

  yearSelect.addEventListener('change', onPeriodChange);
  monthSelect.addEventListener('change', onPeriodChange);
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById(`tab-${t.dataset.tab}`).classList.add('active');
      if (t.dataset.tab === 'chart') loadAllCharts();
      if (t.dataset.tab === 'events') loadEvents();
      if (t.dataset.tab === 'symbols') loadSymbolsList();
    });
  });
}

function initButtons() {
  document.getElementById('btnUpdate').addEventListener('click', () => {
    loadTableData(true);
    if (isTabActive('events')) loadEvents(true);
  });
  document.getElementById('btnViewData').addEventListener('click', showDataViewer);
  document.getElementById('btnDownloadData').addEventListener('click', downloadTableAsExcel);
  document.getElementById('dataViewerClose').addEventListener('click', hideDataViewer);
  document.getElementById('btnViewerDownload').addEventListener('click', downloadTableAsExcel);
  document.getElementById('errorPopupClose').addEventListener('click', hideErrorPopup);
  document.getElementById('errorPopup').addEventListener('click', (e) => {
    if (e.target.id === 'errorPopup') hideErrorPopup();
  });
  document.getElementById('dataViewerPopup').addEventListener('click', (e) => {
    if (e.target.id === 'dataViewerPopup') hideDataViewer();
  });
  initSymbolChangePopup();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideErrorPopup();
      hideDataViewer();
    }
  });
}

async function loadTableData(forceUpdate = false) {
  const btn = document.getElementById('btnUpdate');
  btn.disabled = true;
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '<tr><td colspan="100" class="loading">데이터 로딩 중...</td></tr>';

  try {
    const url = forceUpdate
      ? `${API}/update/${currentYear}/${currentMonth}`
      : `${API}/daily/${currentYear}/${currentMonth}`;
    const res = await fetch(url);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(res.ok ? '응답 형식 오류' : `서버 오류 (${res.status})`);
    }

    if (!res.ok || json.success === false) {
      showErrorPopup('데이터 조회 실패', json?.error || `HTTP ${res.status}`, json?.cause);
      tbody.innerHTML = '<tr><td colspan="100" class="empty">데이터를 불러올 수 없습니다.</td></tr>';
      return;
    }

    if (json.failed && json.failed.length > 0) {
      const list = json.failed.map(f => `${f.name}: ${f.reason}`).join('\n');
      showErrorPopup('일부 데이터 누락', `${json.failed.length}개 항목을 불러오지 못했습니다.`, list);
    }

    currentData = json;
    const periodKey = makePeriodKey(json.year, json.month);
    dailyCache.set(periodKey, json);
    renderTable(json);
    if (isTabActive('chart') && makePeriodKey(currentYear, currentMonth) === periodKey) {
      renderChartsFromData(json, { force: true });
    }
  } catch (e) {
    const msg = e.message || '네트워크 연결을 확인해 주세요';
    const cause = e.name === 'TypeError' && e.message.includes('fetch') ? '서버에 연결할 수 없습니다. 서버가 실행 중인지 확인하세요.' : null;
    showErrorPopup('오류 발생', msg, cause);
    tbody.innerHTML = '<tr><td colspan="100" class="empty">데이터를 불러올 수 없습니다.</td></tr>';
  } finally {
    btn.disabled = false;
  }
}

function renderTable(json) {
  const { data, items } = json;
  if (!data || !items) return;

  const allDates = new Set();
  items.forEach(item => {
    (data[item.id] || []).forEach(d => allDates.add(d.date));
  });
  const dates = [...allDates].sort();

  const itemDataMaps = {};
  items.forEach(item => {
    const map = new Map();
    (data[item.id] || []).forEach(d => map.set(d.date, d));
    itemDataMaps[item.id] = map;
  });

  const thead = document.getElementById('tableHeader');
  thead.innerHTML = `<th>날짜</th>${items.map(i => `<th>${i.name}</th>`).join('')}`;

  const prevCloses = {};
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = dates.map(date => {
    let row = `<td>${date}</td>`;
    items.forEach(item => {
      const rec = itemDataMaps[item.id].get(date);
      let cell = '-';
      if (rec) {
        const prev = prevCloses[item.id];
        let cls = 'price-same';
        let arrow = '';
        if (prev != null) {
          const diff = rec.close - prev;
          if (diff > 0) { cls = 'price-up'; arrow = 'arrow-up'; }
          else if (diff < 0) { cls = 'price-down'; arrow = 'arrow-down'; }
        }
        prevCloses[item.id] = rec.close;
        const fmt = formatPrice(rec.close, item.unit);
        cell = `<span class="${cls} ${arrow}">${fmt}</span>`;
      }
      row += `<td>${cell}</td>`;
    });
    return `<tr>${row}</tr>`;
  }).join('');

  if (dates.length === 0) {
    tbody.innerHTML = '<tr><td colspan="100" class="empty">해당 월 데이터가 없습니다.</td></tr>';
  }
}

function formatPrice(val, unit) {
  if (val == null || isNaN(val)) return '-';
  const n = Number(val);
  if (unit === '%') return n.toFixed(2) + '%';
  if (n >= 1000) return n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function formatPriceForExport(val, unit) {
  if (val == null || isNaN(val)) return '';
  const n = Number(val);
  if (unit === '%') return n.toFixed(2);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function buildTableData() {
  if (!currentData || !currentData.data || !currentData.items) return null;
  const { data, items } = currentData;
  const allDates = new Set();
  items.forEach(item => {
    (data[item.id] || []).forEach(d => allDates.add(d.date));
  });
  const dates = [...allDates].sort();
  const itemDataMaps = {};
  items.forEach(item => {
    const map = new Map();
    (data[item.id] || []).forEach(d => map.set(d.date, d));
    itemDataMaps[item.id] = map;
  });
  const headers = ['날짜', ...items.map(i => i.name)];
  const rows = dates.map(date => {
    const cells = [date];
    items.forEach(item => {
      const rec = itemDataMaps[item.id].get(date);
      cells.push(rec ? formatPriceForExport(rec.close, item.unit) : '');
    });
    return cells;
  });
  return { headers, rows, year: currentData.year, month: currentData.month };
}

function escapeCSVCell(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCSV(tableData) {
  if (!tableData || !tableData.headers || !tableData.rows) return '';
  const lines = [tableData.headers.map(escapeCSVCell).join(',')];
  tableData.rows.forEach(r => lines.push(r.map(escapeCSVCell).join(',')));
  return lines.join('\r\n');
}

function downloadTableAsExcel() {
  const tableData = buildTableData();
  if (!tableData || tableData.rows.length === 0) {
    showErrorPopup('다운로드 실패', '다운로드할 데이터가 없습니다.', null);
    return;
  }
  const csv = buildCSV(tableData);
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `주가데이터_${tableData.year}${String(tableData.month).padStart(2, '0')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderDataViewer(tableData) {
  const wrap = document.getElementById('dataViewerTableWrap');
  const { headers, rows } = tableData;
  const thead = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
  const tbody = rows.map(row =>
    `<tr>${row.map(cell => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`
  ).join('');
  wrap.innerHTML = `<table class="viewer-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
}

function showDataViewer() {
  const tableData = buildTableData();
  if (!tableData || tableData.rows.length === 0) {
    showErrorPopup('데이터 보기', '표시할 데이터가 없습니다.', null);
    return;
  }
  document.getElementById('dataViewerTitle').textContent = `데이터 뷰어 (${tableData.year}년 ${tableData.month}월)`;
  renderDataViewer(tableData);
  document.getElementById('dataViewerPopup').classList.add('visible');
}

function hideDataViewer() {
  document.getElementById('dataViewerPopup').classList.remove('visible');
}

function initChartSymbols() {}

async function loadAllCharts() {
  const grid = document.getElementById('chartsGrid');
  const key = makePeriodKey(currentYear, currentMonth);
  const cached = dailyCache.get(key);
  const alreadyShowing = lastRenderedChartKey === key && grid.children.length > 0;

  if (!alreadyShowing) {
    if (cached) {
      renderChartsFromData(cached);
    } else {
      grid.innerHTML = '<div class="loading" style="grid-column:1/-1">차트 로딩 중...</div>';
    }
  }

  const token = `${key}-${Date.now()}`;
  chartRequestToken = token;

  try {
    const res = await fetch(`${API}/daily/${currentYear}/${currentMonth}`);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(res.ok ? '응답 형식 오류' : `서버 오류 (${res.status})`);
    }
    if (!res.ok || json.success === false) {
      showErrorPopup('차트 데이터 조회 실패', json?.error || '알 수 없는 오류', json?.cause);
      if (!cached && !alreadyShowing) {
        grid.innerHTML = '<div class="empty" style="grid-column:1/-1">데이터를 불러올 수 없습니다.</div>';
      }
      return;
    }

    const responseKey = makePeriodKey(json.year, json.month);
    dailyCache.set(responseKey, json);
    if (chartRequestToken !== token || responseKey !== makePeriodKey(currentYear, currentMonth)) return;
    renderChartsFromData(json, { force: true });
  } catch (e) {
    showErrorPopup('차트 로드 오류', e.message, e.message.includes('fetch') ? '서버 연결을 확인하세요.' : null);
    if (!cached && !alreadyShowing) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1">데이터를 불러올 수 없습니다.</div>';
    }
  }
}

function renderChartsFromData(json, { force = false } = {}) {
  const key = makePeriodKey(json.year, json.month);
  if (!force && lastRenderedChartKey === key) return;
  lastRenderedChartKey = key;

  const grid = document.getElementById('chartsGrid');
  priceCharts.forEach(c => c?.destroy());
  priceCharts = [];
  grid.innerHTML = '';

  const { data, items } = json;
  const RED = '#f85149';
  const YELLOW = '#d29922';
  const BLUE = '#58a6ff';

  items.forEach((item, idx) => {
    const arr = (data[item.id] || []).sort((a, b) => a.date.localeCompare(b.date));
    const closes = arr.map(d => d.close).filter(v => v != null);

    const dropFromHighPct = calcDropFromHighPct(closes);
    const currentConsecDown = getCurrentConsecDownDays(closes);
    const monthChangePct = calcMonthChangePct(closes);

    let useRed = false;
    let useYellow = false;
    if (closes.length >= 1) {
      if (dropFromHighPct <= -5) {
        useYellow = true;
      } else if (currentConsecDown >= 2 || dropFromHighPct <= -3) {
        useRed = true;
      }
    }

    const lineColor = useYellow ? YELLOW : (useRed ? RED : BLUE);
    const fillColor = useYellow ? 'rgba(210, 153, 34, 0.1)' : (useRed ? 'rgba(248, 81, 73, 0.1)' : 'rgba(88, 166, 255, 0.1)');
    const changeClass = monthChangePct > 0 ? 'positive' : monthChangePct < 0 ? 'negative' : 'neutral';
    const safeName = escapeHtml(item.name);
    const rsi = calcRSI2(closes);
    const signal = getRSISignal(rsi);
    const rsiText = rsi != null ? `RSI(2) ${rsi.toFixed(1)}` : 'RSI -';
    const signalHtml = signal.label
      ? `<span class="rsi-signal ${signal.className}">${escapeHtml(signal.label)}</span>`
      : '';
    const card = document.createElement('div');
    card.className = 'chart-card';
    card.innerHTML = `
      <div class="chart-card-title">
        <span class="chart-card-name" title="${safeName}">${safeName}</span>
        ${signalHtml}
        <span class="chart-rsi" title="2일 RSI">${escapeHtml(rsiText)}</span>
        <span class="chart-card-change ${changeClass}">${formatChangePct(monthChangePct)}</span>
      </div>
      <canvas id="chart-${idx}"></canvas>
    `;
    grid.appendChild(card);

    const ctx = document.getElementById(`chart-${idx}`).getContext('2d');
    const chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: arr.map(d => d.date),
        datasets: [{
          label: item.name,
          data: arr.map(d => d.close),
          borderColor: lineColor,
          backgroundColor: fillColor,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          pointHoverRadius: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            grid: { color: '#30363d', display: false },
            ticks: { color: '#8b949e', maxTicksLimit: 4, font: { size: 9 } }
          },
          y: {
            grid: { color: '#30363d' },
            ticks: { color: '#8b949e', maxTicksLimit: 3, font: { size: 9 } }
          }
        }
      }
    });
    priceCharts.push(chart);
  });
}

// ---------- 항목 관리 (심볼 변경/복원) ----------
let symbolsListCache = null;

async function loadSymbolsList() {
  const listEl = document.getElementById('symbolsList');
  if (!listEl) return;
  try {
    const res = await fetch(`${API}/symbols`);
    const json = await res.json();
    if (!res.ok || !json.items) throw new Error(json.error || '목록 조회 실패');
    symbolsListCache = json.items;
    listEl.innerHTML = json.items.map((item) => {
      const overriddenBadge = item.overridden ? '<span class="symbol-overridden-badge">변경됨</span>' : '';
      const restoreBtn = item.overridden
        ? `<button type="button" class="btn-secondary btn-sm btn-restore" data-id="${escapeHtml(item.id)}">원래대로</button>`
        : '';
      return `
        <li class="symbols-list-item" data-id="${escapeHtml(item.id)}">
          <span class="symbols-list-name">${escapeHtml(item.name)}</span>
          <span class="symbols-list-symbol">${escapeHtml(item.symbol)}</span>
          ${overriddenBadge}
          <div class="symbols-list-actions">
            <button type="button" class="btn-primary btn-sm btn-change" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}" data-symbol="${escapeHtml(item.symbol)}">변경</button>
            ${restoreBtn}
          </div>
        </li>
      `;
    }).join('');
    listEl.querySelectorAll('.btn-change').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const name = btn.dataset.name;
        const symbol = btn.dataset.symbol;
        openSymbolChangePopup({ id, name, symbol });
      });
    });
    listEl.querySelectorAll('.btn-restore').forEach((btn) => {
      btn.addEventListener('click', () => restoreSymbolOverride(btn.dataset.id));
    });
  } catch (e) {
    showErrorPopup('항목 목록 조회 실패', e.message);
    listEl.innerHTML = '<li class="empty">목록을 불러올 수 없습니다.</li>';
  }
}

let symbolChangeCurrentItem = null;
let validatedSymbol = null;
let validatedName = null;

function openSymbolChangePopup(item) {
  symbolChangeCurrentItem = item;
  validatedSymbol = null;
  validatedName = null;
  document.getElementById('symbolChangeTitle').textContent = `다른 종목으로 변경: ${item.name}`;
  document.getElementById('symbolChangeCurrent').textContent = `현재: ${item.name} (${item.symbol})`;
  document.getElementById('symbolChangeInput').value = '';
  document.getElementById('symbolValidateMessage').textContent = '';
  document.getElementById('symbolValidateMessage').className = 'symbol-validate-message';
  document.getElementById('symbolConfirmBlock').hidden = true;
  document.getElementById('symbolChangeBtnConfirm').hidden = true;
  const resultsEl = document.getElementById('symbolSearchResults');
  resultsEl.hidden = true;
  resultsEl.innerHTML = '';
  document.getElementById('symbolChangePopup').classList.add('visible');
  document.getElementById('symbolChangeInput').focus();
}

function hideSymbolChangePopup() {
  document.getElementById('symbolChangePopup').classList.remove('visible');
  symbolChangeCurrentItem = null;
  validatedSymbol = null;
  validatedName = null;
}

let symbolSearchDebounceTimer = null;

async function runSymbolSearch() {
  const input = document.getElementById('symbolChangeInput').value.trim();
  const resultsEl = document.getElementById('symbolSearchResults');
  const msgEl = document.getElementById('symbolValidateMessage');
  if (!input || input.length < 2) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
    msgEl.textContent = '2글자 이상 입력하세요.';
    msgEl.className = 'symbol-validate-message';
    return;
  }
  msgEl.textContent = '검색 중...';
  msgEl.className = 'symbol-validate-message';
  try {
    const res = await fetch(`${API}/symbols/search?q=${encodeURIComponent(input)}`);
    const json = await res.json();
    const list = json.suggestions || [];
    if (list.length === 0) {
      msgEl.textContent = '유사한 종목이 없습니다. 다른 검색어를 입력해 보세요.';
      msgEl.className = 'symbol-validate-message error';
      resultsEl.hidden = true;
      resultsEl.innerHTML = '';
      return;
    }
    msgEl.textContent = '';
    resultsEl.innerHTML = list.map((s) => `
      <button type="button" class="symbol-search-item" data-symbol="${escapeHtml(s.symbol)}" data-name="${escapeHtml(s.name)}">
        <span class="symbol-search-name">${escapeHtml(s.name)}</span>
        <span class="symbol-search-symbol">${escapeHtml(s.symbol)}</span>
        ${s.exchange ? `<span class="symbol-search-exchange">${escapeHtml(s.exchange)}</span>` : ''}
      </button>
    `).join('');
    resultsEl.hidden = false;
    resultsEl.querySelectorAll('.symbol-search-item').forEach((btn) => {
      btn.addEventListener('click', () => selectSymbolFromSearch(btn.dataset.symbol, btn.dataset.name));
    });
  } catch (e) {
    msgEl.textContent = e.message || '검색 중 오류가 발생했습니다.';
    msgEl.className = 'symbol-validate-message error';
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
  }
}

function selectSymbolFromSearch(symbol, name) {
  validatedSymbol = symbol;
  validatedName = name;
  document.getElementById('symbolSearchResults').hidden = true;
  document.getElementById('symbolSearchResults').innerHTML = '';
  document.getElementById('symbolValidateMessage').textContent = `선택: ${name} (${symbol})`;
  document.getElementById('symbolValidateMessage').className = 'symbol-validate-message success';
  document.getElementById('symbolConfirmInfo').textContent = `"${symbolChangeCurrentItem.name}" 항목을 "${name}" (${symbol})로 변경합니다.`;
  document.getElementById('symbolConfirmBlock').hidden = false;
  document.getElementById('symbolChangeBtnConfirm').hidden = false;
}

async function confirmSymbolOverride() {
  if (!symbolChangeCurrentItem || !validatedSymbol) return;
  const btnConfirm = document.getElementById('symbolChangeBtnConfirm');
  btnConfirm.disabled = true;
  try {
    const res = await fetch(`${API}/symbols/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: symbolChangeCurrentItem.id,
        symbol: validatedSymbol,
        name: validatedName
      })
    });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || '변경 실패');
    hideSymbolChangePopup();
    dailyCache.clear();
    eventsCache.clear();
    lastRenderedChartKey = null;
    lastRenderedEventsKey = null;
    loadSymbolsList();
    loadTableData(true);
    if (isTabActive('chart')) loadAllCharts();
    if (isTabActive('events')) loadEvents(true);
  } catch (e) {
    showErrorPopup('항목 변경 실패', e.message);
  } finally {
    btnConfirm.disabled = false;
  }
}

async function restoreSymbolOverride(id) {
  try {
    const res = await fetch(`${API}/symbols/override/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json.error || '복원 실패');
    dailyCache.clear();
    eventsCache.clear();
    lastRenderedChartKey = null;
    lastRenderedEventsKey = null;
    loadSymbolsList();
    loadTableData(true);
    if (isTabActive('chart')) loadAllCharts();
    if (isTabActive('events')) loadEvents(true);
  } catch (e) {
    showErrorPopup('원래대로 복원 실패', e.message);
  }
}

function initSymbolChangePopup() {
  document.getElementById('symbolChangeClose').addEventListener('click', hideSymbolChangePopup);
  document.getElementById('symbolChangeBtnCancel').addEventListener('click', hideSymbolChangePopup);
  document.getElementById('symbolChangePopup').addEventListener('click', (e) => {
    if (e.target.id === 'symbolChangePopup') hideSymbolChangePopup();
  });
  document.getElementById('symbolChangeBtnConfirm').addEventListener('click', confirmSymbolOverride);
  const searchInput = document.getElementById('symbolChangeInput');
  searchInput.addEventListener('input', () => {
    clearTimeout(symbolSearchDebounceTimer);
    symbolSearchDebounceTimer = setTimeout(runSymbolSearch, 350);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(symbolSearchDebounceTimer);
      runSymbolSearch();
    }
  });
}

function setEventsTableHeader() {
  document.getElementById('eventsTableHead').innerHTML = '<th>날짜</th><th>항목</th><th>변동</th><th>매도 시점 경고</th>';
}

async function loadEvents(forceRefresh = false) {
  const year = currentYear;
  const month = currentMonth;
  const tbody = document.getElementById('eventsBody');
  const key = makePeriodKey(year, month);
  const cached = eventsCache.get(key);
  const alreadyShowing = lastRenderedEventsKey === key && tbody.children.length > 0;

  if (forceRefresh) {
    eventsCache.delete(key);
    setEventsTableHeader();
    tbody.innerHTML = '<tr><td colspan="4" class="loading">업데이트 중...</td></tr>';
  } else if (!alreadyShowing) {
    if (cached) {
      renderEvents(cached);
    } else {
      setEventsTableHeader();
      tbody.innerHTML = '<tr><td colspan="4" class="loading">로딩 중...</td></tr>';
    }
  }

  const token = `${key}-${Date.now()}`;
  eventsRequestToken = token;

  try {
    const url = forceRefresh ? `${API}/events/${year}/${month}?refresh=1` : `${API}/events/${year}/${month}`;
    const res = await fetch(url);
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(res.ok ? '응답 형식 오류' : `서버 오류 (${res.status})`);
    }
    if (!res.ok || json.success === false) {
      showErrorPopup('이벤트 조회 실패', json?.error || '알 수 없는 오류', json?.cause);
      if (!cached && !alreadyShowing) {
        setEventsTableHeader();
        tbody.innerHTML = '<tr><td colspan="4" class="empty">데이터를 불러올 수 없습니다.</td></tr>';
      }
      return;
    }
    if (json.failed && json.failed.length > 0) {
      const list = json.failed.map(f => `${f.name}: ${f.reason}`).join('\n');
      showErrorPopup('일부 데이터 누락', `${json.failed.length}개 항목을 불러오지 못했습니다.`, list);
    }
    const responseKey = makePeriodKey(json.year, json.month);
    eventsCache.set(responseKey, json);
    if (eventsRequestToken !== token || responseKey !== makePeriodKey(year, month)) return;
    renderEvents(json, { force: true });
  } catch (e) {
    showErrorPopup('이벤트 조회 오류', e.message, e.message.includes('fetch') ? '서버 연결을 확인하세요.' : null);
    if (!cached && !alreadyShowing) {
      setEventsTableHeader();
      tbody.innerHTML = '<tr><td colspan="4" class="empty">데이터를 불러올 수 없습니다.</td></tr>';
    }
  }
}

function renderEvents(json, { force = false } = {}) {
  const tbody = document.getElementById('eventsBody');
  const key = makePeriodKey(json.year, json.month);
  if (!force && lastRenderedEventsKey === key && tbody.children.length > 0) return;
  lastRenderedEventsKey = key;
  const events = json.events || {};
  const dates = Object.keys(events).sort();

  if (dates.length === 0) {
    setEventsTableHeader();
    tbody.innerHTML = '<tr><td colspan="4" class="empty">해당 월에 가격 변동 3% 이상인 이벤트가 없습니다.</td></tr>';
    return;
  }

  setEventsTableHeader();
  tbody.innerHTML = dates.flatMap(date =>
    events[date].map(ev => `
      <tr>
        <td>${escapeHtml(date)}</td>
        <td>${escapeHtml(ev.item)}</td>
        <td class="${ev.type === '상승' ? 'event-up' : 'event-down'}">${ev.type} ${ev.change >= 0 ? '+' : ''}${ev.change.toFixed(2)}%</td>
        <td class="event-warning">${escapeHtml(ev.sellWarning || '-')}</td>
      </tr>
    `)
  ).join('');
}

function init() {
  initSelectors();
  initTabs();
  initButtons();
  initChartSymbols();
  loadTableData();
}

init();
