/**
 * A 股选股器 — 交互逻辑
 * 筛选条件管理、API 调用、结果渲染、CSV 导出
 */

// ============================================================
// 状态管理
// ============================================================

const DEFAULT_FILTERS = {
  change_pct: { enabled: true, min_val: 3, max_val: 5 },
  limit_up: { enabled: true, extra: { days: 20, min_count: 1 } },
  limit_up_consolidation: { enabled: false, extra: { days: 20, min_count: 2, range_low: -10, range_high: 5 } },
  volume_ratio: { enabled: true, min_val: 1 },
  turnover_rate: { enabled: true, min_val: 5, max_val: 10 },
  market_cap: { enabled: true, min_val: 50, max_val: 200 }
};

const STORAGE_KEY = 'stockScreenerFilters';

let sectorSortMode = 'inflow';

let state = {
  filters: loadFilters(),
  lastData: null,
  isLoading: false,
  sortCol: null,
  sortDir: null,
  selectedIndustry: '',
  autoRefresh: { enabled: false, interval: 30, countdown: 0, timerId: null }
};

function loadFilters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // 深度合并，确保所有键都存在
      return deepMerge(DEFAULT_FILTERS, parsed);
    }
  } catch (e) {
    console.warn('读取筛选条件缓存失败:', e);
  }
  return JSON.parse(JSON.stringify(DEFAULT_FILTERS));
}

function saveFilters() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.filters));
  } catch (e) {
    console.warn('保存筛选条件失败:', e);
  }
}

function deepMerge(defaults, source) {
  const result = {};
  for (const key of Object.keys(defaults)) {
    if (source && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = Object.assign({}, defaults[key], source[key]);
    } else if (source && source.hasOwnProperty(key)) {
      result[key] = source[key];
    } else {
      result[key] = defaults[key];
    }
  }
  return result;
}

// ============================================================
// DOM 引用
// ============================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const filterBar = $('#filter-bar');
const statsRow = $('#stats-row');
const statTotal = $('#stat-total');
const statMatched = $('#stat-matched');
const statTime = $('#stat-time');
const statRate = $('#stat-rate');
const skeletonContainer = $('#skeleton-container');
const errorPanel = $('#error-panel');
const errorMessage = $('#error-message');
const emptyState = $('#empty-state');
const tableWrapper = $('#table-wrapper');
const tableBody = $('#table-body');
const btnExport = $('#btn-export');
const sectorList = $('#sector-list');
const sectorLoading = $('#sector-loading');
const sectorError = $('#sector-error');
const hotIndustriesList = $('#hot-industries-list');

// 热门板块集合
let hotSectors = new Set();

// ============================================================
// 工具函数
// ============================================================

/** HTML 转义，防止 XSS */
function esc(s) {
  if (s === null || s === undefined) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return String(s).replace(/[&<>"']/g, function (m) { return map[m]; });
}

/** 创建 Toggle 开关元素 */
function makeToggle(onChange, initial) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'toggle' + (initial ? ' on' : '');
  el.setAttribute('aria-pressed', initial ? 'true' : 'false');
  el.addEventListener('click', function () {
    const isOn = el.classList.toggle('on');
    el.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    if (typeof onChange === 'function') {
      onChange(isOn);
    }
  });
  return el;
}

/** 创建数字输入框 */
function makeInput(value, onChange, enabled, sizeClass) {
  const el = document.createElement('input');
  el.type = 'number';
  el.step = 'any';
  el.className = 'filter-input' + (sizeClass ? ' ' + sizeClass : '');
  el.value = value;
  if (!enabled) {
    el.disabled = true;
  }
  el.addEventListener('change', function () {
    if (typeof onChange === 'function') {
      onChange(parseFloat(this.value) || 0);
    }
  });
  return el;
}

// ============================================================
// 渲染筛选条件栏
// ============================================================

function renderFilters() {
  filterBar.innerHTML = '';

  const f = state.filters;

  // ── 涨幅 ──
  const grpChangePct = document.createElement('div');
  grpChangePct.className = 'filter-group';

  const toggleCP = makeToggle(function (isOn) {
    f.change_pct.enabled = isOn;
    saveFilters();
    updateGroupDisabled(grpChangePct, isOn);
  }, f.change_pct.enabled);

  const labelCP = document.createElement('span');
  labelCP.className = 'filter-label';
  labelCP.textContent = '涨幅';

  const inpCPMin = makeInput(f.change_pct.min_val, function (v) {
    f.change_pct.min_val = v;
    saveFilters();
  }, f.change_pct.enabled, 'filter-input-sm');

  const sepCP = document.createElement('span');
  sepCP.className = 'filter-separator';
  sepCP.textContent = '~';

  const inpCPMax = makeInput(f.change_pct.max_val, function (v) {
    f.change_pct.max_val = v;
    saveFilters();
  }, f.change_pct.enabled, 'filter-input-sm');

  const unitCP = document.createElement('span');
  unitCP.className = 'filter-unit';
  unitCP.textContent = '%';

  grpChangePct.appendChild(toggleCP);
  grpChangePct.appendChild(labelCP);
  grpChangePct.appendChild(inpCPMin);
  grpChangePct.appendChild(unitCP.cloneNode(true));
  grpChangePct.appendChild(sepCP);
  grpChangePct.appendChild(inpCPMax);
  grpChangePct.appendChild(unitCP);

  // ── 涨停近20日 ──
  const grpLimitUp = document.createElement('div');
  grpLimitUp.className = 'filter-group';

  const toggleLU = makeToggle(function (isOn) {
    f.limit_up.enabled = isOn;
    saveFilters();
    updateGroupDisabled(grpLimitUp, isOn);
  }, f.limit_up.enabled);

  const labelLU = document.createElement('span');
  labelLU.className = 'filter-label';
  labelLU.textContent = '涨停';

  const prefixLU = document.createElement('span');
  prefixLU.className = 'filter-separator';
  prefixLU.textContent = '近';

  const inpLUDays = makeInput(f.limit_up.extra.days, function (v) {
    f.limit_up.extra.days = v;
    saveFilters();
  }, f.limit_up.enabled, 'filter-input-sm');

  const midLU = document.createElement('span');
  midLU.className = 'filter-separator';
  midLU.textContent = '日 ≥';

  const inpLUCount = makeInput(f.limit_up.extra.min_count, function (v) {
    f.limit_up.extra.min_count = v;
    saveFilters();
  }, f.limit_up.enabled, 'filter-input-sm');

  const suffixLU = document.createElement('span');
  suffixLU.className = 'filter-unit';
  suffixLU.textContent = '次';

  grpLimitUp.appendChild(toggleLU);
  grpLimitUp.appendChild(labelLU);
  grpLimitUp.appendChild(prefixLU);
  grpLimitUp.appendChild(inpLUDays);
  grpLimitUp.appendChild(midLU);
  grpLimitUp.appendChild(inpLUCount);
  grpLimitUp.appendChild(suffixLU);

  // ── 量比 ──
  const grpVolRatio = document.createElement('div');
  grpVolRatio.className = 'filter-group';

  const toggleVR = makeToggle(function (isOn) {
    f.volume_ratio.enabled = isOn;
    saveFilters();
    updateGroupDisabled(grpVolRatio, isOn);
  }, f.volume_ratio.enabled);

  const labelVR = document.createElement('span');
  labelVR.className = 'filter-label';
  labelVR.textContent = '量比';

  const prefixVR = document.createElement('span');
  prefixVR.className = 'filter-separator';
  prefixVR.textContent = '≥';

  const inpVR = makeInput(f.volume_ratio.min_val, function (v) {
    f.volume_ratio.min_val = v;
    saveFilters();
  }, f.volume_ratio.enabled, 'filter-input-sm');

  grpVolRatio.appendChild(toggleVR);
  grpVolRatio.appendChild(labelVR);
  grpVolRatio.appendChild(prefixVR);
  grpVolRatio.appendChild(inpVR);

  // ── 换手率 ──
  const grpTurnover = document.createElement('div');
  grpTurnover.className = 'filter-group';

  const toggleTO = makeToggle(function (isOn) {
    f.turnover_rate.enabled = isOn;
    saveFilters();
    updateGroupDisabled(grpTurnover, isOn);
  }, f.turnover_rate.enabled);

  const labelTO = document.createElement('span');
  labelTO.className = 'filter-label';
  labelTO.textContent = '换手率';

  const inpTOMin = makeInput(f.turnover_rate.min_val, function (v) {
    f.turnover_rate.min_val = v;
    saveFilters();
  }, f.turnover_rate.enabled, 'filter-input-sm');

  const unitTO = document.createElement('span');
  unitTO.className = 'filter-unit';
  unitTO.textContent = '%';

  const sepTO = document.createElement('span');
  sepTO.className = 'filter-separator';
  sepTO.textContent = '~';

  const inpTOMax = makeInput(f.turnover_rate.max_val, function (v) {
    f.turnover_rate.max_val = v;
    saveFilters();
  }, f.turnover_rate.enabled, 'filter-input-sm');

  grpTurnover.appendChild(toggleTO);
  grpTurnover.appendChild(labelTO);
  grpTurnover.appendChild(inpTOMin);
  grpTurnover.appendChild(unitTO.cloneNode(true));
  grpTurnover.appendChild(sepTO);
  grpTurnover.appendChild(inpTOMax);
  grpTurnover.appendChild(unitTO.cloneNode(true));

  // ── 市值 ──
  const grpMarketCap = document.createElement('div');
  grpMarketCap.className = 'filter-group';

  const toggleMC = makeToggle(function (isOn) {
    f.market_cap.enabled = isOn;
    saveFilters();
    updateGroupDisabled(grpMarketCap, isOn);
  }, f.market_cap.enabled);

  const labelMC = document.createElement('span');
  labelMC.className = 'filter-label';
  labelMC.textContent = '市值';

  const inpMCMin = makeInput(f.market_cap.min_val, function (v) {
    f.market_cap.min_val = v;
    saveFilters();
  }, f.market_cap.enabled, 'filter-input-md');

  const sepMC1 = document.createElement('span');
  sepMC1.className = 'filter-unit';
  sepMC1.textContent = '亿 ~';

  const inpMCMax = makeInput(f.market_cap.max_val, function (v) {
    f.market_cap.max_val = v;
    saveFilters();
  }, f.market_cap.enabled, 'filter-input-md');

  const sepMC2 = document.createElement('span');
  sepMC2.className = 'filter-unit';
  sepMC2.textContent = '亿';

  grpMarketCap.appendChild(toggleMC);
  grpMarketCap.appendChild(labelMC);
  grpMarketCap.appendChild(inpMCMin);
  grpMarketCap.appendChild(sepMC1);
  grpMarketCap.appendChild(inpMCMax);
  grpMarketCap.appendChild(sepMC2);

  // ── 涨停整理 ──
  const grpConsolidation = document.createElement('div');
  grpConsolidation.className = 'filter-group';

  const toggleCO = makeToggle(function (isOn) {
    f.limit_up_consolidation.enabled = isOn;
    saveFilters();
    updateGroupDisabled(grpConsolidation, isOn);
  }, f.limit_up_consolidation.enabled);

  const labelCO = document.createElement('span');
  labelCO.className = 'filter-label';
  labelCO.textContent = '涨停整理';

  const preCO1 = document.createElement('span');
  preCO1.className = 'filter-separator';
  preCO1.textContent = '近';

  const inpCODays = makeInput(f.limit_up_consolidation.extra.days, function (v) {
    f.limit_up_consolidation.extra.days = v;
    saveFilters();
  }, f.limit_up_consolidation.enabled, 'filter-input-sm');

  const midCO1 = document.createElement('span');
  midCO1.className = 'filter-separator';
  midCO1.textContent = '日 ≥';

  const inpCOCount = makeInput(f.limit_up_consolidation.extra.min_count, function (v) {
    f.limit_up_consolidation.extra.min_count = v;
    saveFilters();
  }, f.limit_up_consolidation.enabled, 'filter-input-sm');

  const midCO2 = document.createElement('span');
  midCO2.className = 'filter-separator';
  midCO2.textContent = '次 整理';

  const inpCORangeLow = makeInput(f.limit_up_consolidation.extra.range_low, function (v) {
    f.limit_up_consolidation.extra.range_low = v;
    saveFilters();
  }, f.limit_up_consolidation.enabled, 'filter-input-sm');

  const midCO3 = document.createElement('span');
  midCO3.className = 'filter-separator';
  midCO3.textContent = '% ~';

  const inpCORangeHigh = makeInput(f.limit_up_consolidation.extra.range_high, function (v) {
    f.limit_up_consolidation.extra.range_high = v;
    saveFilters();
  }, f.limit_up_consolidation.enabled, 'filter-input-sm');

  const unitCO = document.createElement('span');
  unitCO.className = 'filter-unit';
  unitCO.textContent = '%';

  grpConsolidation.appendChild(toggleCO);
  grpConsolidation.appendChild(labelCO);
  grpConsolidation.appendChild(preCO1);
  grpConsolidation.appendChild(inpCODays);
  grpConsolidation.appendChild(midCO1);
  grpConsolidation.appendChild(inpCOCount);
  grpConsolidation.appendChild(midCO2);
  grpConsolidation.appendChild(inpCORangeLow);
  grpConsolidation.appendChild(midCO3);
  grpConsolidation.appendChild(inpCORangeHigh);
  grpConsolidation.appendChild(unitCO);

  // ── 操作区 —— 开始筛选按钮 ──
  const filterActions = document.createElement('div');
  filterActions.className = 'filter-actions';

  const btnScreen = document.createElement('button');
  btnScreen.type = 'button';
  btnScreen.className = 'btn-primary';
  btnScreen.textContent = '开始筛选';
  btnScreen.addEventListener('click', doScreen);

  filterActions.appendChild(btnScreen);

  // ── 行业 ──
  var grpIndustry = document.createElement('div');
  grpIndustry.className = 'filter-group';

  var labelInd = document.createElement('span');
  labelInd.className = 'filter-label';
  labelInd.textContent = '行业';

  var selectInd = document.createElement('select');
  selectInd.id = 'industry-select';
  selectInd.className = 'filter-select';
  selectInd.addEventListener('change', function () {
    state.selectedIndustry = this.value;
    if (state.lastData) renderResults(state.lastData);
  });

  var optAll = document.createElement('option');
  optAll.value = '';
  optAll.textContent = '全部行业';
  selectInd.appendChild(optAll);

  grpIndustry.appendChild(labelInd);
  grpIndustry.appendChild(selectInd);

  // ── 自动刷新 ──
  var grpAutoRefresh = document.createElement('div');
  grpAutoRefresh.className = 'filter-group';

  var toggleAR = makeToggle(function (isOn) {
    state.autoRefresh.enabled = isOn;
    if (isOn) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  }, state.autoRefresh.enabled);

  var labelAR = document.createElement('span');
  labelAR.className = 'filter-label';
  labelAR.textContent = '自动刷新';

  var selectInterval = document.createElement('select');
  selectInterval.className = 'filter-select';
  selectInterval.addEventListener('change', function () {
    state.autoRefresh.interval = parseInt(this.value, 10);
    if (state.autoRefresh.enabled) {
      startAutoRefresh();
    }
  });

  var intervals = [30, 60, 120];
  for (var i = 0; i < intervals.length; i++) {
    var opt = document.createElement('option');
    opt.value = intervals[i];
    opt.textContent = intervals[i] + '秒';
    if (intervals[i] === state.autoRefresh.interval) opt.selected = true;
    selectInterval.appendChild(opt);
  }

  var countdownSpan = document.createElement('span');
  countdownSpan.id = 'auto-refresh-countdown';
  countdownSpan.className = 'auto-refresh-countdown';
  countdownSpan.style.display = 'none';

  grpAutoRefresh.appendChild(toggleAR);
  grpAutoRefresh.appendChild(labelAR);
  grpAutoRefresh.appendChild(selectInterval);
  grpAutoRefresh.appendChild(countdownSpan);

  // ── 组装 ──
  filterBar.appendChild(grpChangePct);
  filterBar.appendChild(grpLimitUp);
  filterBar.appendChild(grpConsolidation);
  filterBar.appendChild(grpVolRatio);
  filterBar.appendChild(grpTurnover);
  filterBar.appendChild(grpMarketCap);
  filterBar.appendChild(grpIndustry);
  filterBar.appendChild(grpAutoRefresh);
  filterBar.appendChild(filterActions);
}

/** 更新筛选组内部输入框的 disabled 状态 */
function updateGroupDisabled(groupEl, enabled) {
  const inputs = groupEl.querySelectorAll('input');
  inputs.forEach(function (inp) {
    inp.disabled = !enabled;
  });
}

// ============================================================
// 构建请求体
// ============================================================

function buildRequestBody() {
  const f = state.filters;
  const body = { filters: {} };

  for (const key of Object.keys(f)) {
    const item = f[key];
    body.filters[key] = JSON.parse(JSON.stringify(item));
  }

  return body;
}

// ============================================================
// 执行筛选
// ============================================================

async function doScreen() {
  if (state.isLoading) return;

  state.isLoading = true;

  // 重置自动刷新倒计时
  if (state.autoRefresh.enabled) {
    state.autoRefresh.countdown = state.autoRefresh.interval;
    updateCountdownDisplay();
  }

  // 显示骨架屏，隐藏其他面板
  showSkeleton();
  errorPanel.style.display = 'none';
  emptyState.style.display = 'none';
  tableWrapper.style.display = 'none';
  statsRow.style.display = 'none';
  btnExport.style.display = 'none';

  const body = buildRequestBody();

  try {
    const resp = await fetch('/api/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(function () { return ''; });
      throw new Error(errText || '服务器错误 (HTTP ' + resp.status + ')');
    }

    const data = await resp.json();
    state.lastData = data;
    renderResults(data);
    // 同时刷新板块数据
    fetchSectors();
    fetchHotIndustries();
  } catch (err) {
    skeletonContainer.style.display = 'none';
    showError(err.message || '网络请求失败，请检查连接后重试');
  } finally {
    state.isLoading = false;
  }
}

// ============================================================
// 渲染结果
// ============================================================

function renderResults(data) {
  skeletonContainer.style.display = 'none';
  errorPanel.style.display = 'none';

  const total = data.total_scanned || 0;
  const matched = data.matched || 0;
  const updatedAt = data.updated_at || '';
  let stocks = data.stocks || [];

  // 统计行
  statTotal.textContent = esc(String(total));
  statMatched.textContent = esc(String(matched));
  statTime.textContent = esc(formatTime(updatedAt));
  const rate = total > 0 ? ((matched / total) * 100).toFixed(1) + '%' : '--';
  statRate.textContent = rate;
  statsRow.style.display = 'flex';

  // 无匹配结果
  if (!stocks || stocks.length === 0) {
    tableWrapper.style.display = 'none';
    btnExport.style.display = 'none';
    emptyState.style.display = 'flex';
    return;
  }

  // 客户端行业筛选
  if (state.selectedIndustry) {
    stocks = stocks.filter(function (s) {
      return s.sector === state.selectedIndustry;
    });
  }

  // 客户端排序
  if (state.sortCol && state.sortDir && stocks.length > 1) {
    stocks = stocks.slice().sort(function (a, b) {
      var va = a[state.sortCol];
      var vb = b[state.sortCol];
      if (va === null || va === undefined) va = 0;
      if (vb === null || vb === undefined) vb = 0;
      return state.sortDir === 'asc' ? va - vb : vb - va;
    });
  }

  // 更新匹配数（过滤后）
  statMatched.textContent = esc(String(stocks.length));

  // 过滤后无结果
  if (stocks.length === 0) {
    tableWrapper.style.display = 'none';
    btnExport.style.display = 'none';
    emptyState.style.display = 'flex';
    return;
  }

  // 匹配结果
  emptyState.style.display = 'none';
  tableWrapper.style.display = 'block';
  btnExport.style.display = 'inline-flex';

  // 构建表格行
  let rowsHtml = '';
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    rowsHtml += buildStockRow(s);
  }
  tableBody.innerHTML = rowsHtml;
}

function attachSortHandlers() {
  var headers = $$('.stock-table th.sortable');
  headers.forEach(function (th) {
    th.addEventListener('click', function () {
      var col = th.getAttribute('data-sort');
      if (state.sortCol === col) {
        if (state.sortDir === null) state.sortDir = 'asc';
        else if (state.sortDir === 'asc') state.sortDir = 'desc';
        else state.sortDir = null;
      } else {
        state.sortCol = col;
        state.sortDir = 'asc';
      }
      updateSortHeaderUI();
      if (state.lastData) {
        renderResults(state.lastData);
      }
    });
  });
}

function updateSortHeaderUI() {
  var headers = $$('.stock-table th.sortable');
  headers.forEach(function (th) {
    th.classList.remove('sorted-asc', 'sorted-desc');
  });
  if (state.sortCol && state.sortDir) {
    var active = document.querySelector('.stock-table th[data-sort="' + state.sortCol + '"]');
    if (active) {
      active.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  }
}

/** 构建单行 HTML */
function buildStockRow(s) {
  var rawCode = s.code || '';
  const code = esc(s.code || '--');
  const name = esc(s.name || '--');
  const price = formatNum(s.price);
  const changePct = parseFloat(s.change_pct);
  const volRatio = formatNum(s.volume_ratio);
  const turnover = formatNum(s.turnover_rate) + '%';
  const marketCap = formatNum(s.market_cap);
  const limitUpCount = s.limit_up_count;
  var industry = esc(s.sector || '--');
  // 热门板块火焰标记
  if (s.sector && hotSectors.has(s.sector)) {
    industry += ' ' + FIRE_SVG;
  }

  let changeHtml;
  if (isNaN(changePct)) {
    changeHtml = '<span class="cell-change-zero">--</span>';
  } else if (changePct > 0) {
    changeHtml = '<span class="cell-change-up">+' + esc(String(changePct.toFixed(2))) + '%</span>';
  } else if (changePct < 0) {
    changeHtml = '<span class="cell-change-down">' + esc(String(changePct.toFixed(2))) + '%</span>';
  } else {
    changeHtml = '<span class="cell-change-zero">0.00%</span>';
  }

  let limitUpHtml;
  if (limitUpCount === null || limitUpCount === undefined || limitUpCount === '') {
    limitUpHtml = '--';
  } else {
    const lu = Number(limitUpCount);
    limitUpHtml = '<span class="cell-limit-up">' + esc(String(lu)) + '次</span>';
  }

  return '<tr>' +
    '<td class="cell-code" onclick="openStockPage(\'' + rawCode + '\')">' + code + '</td>' +
    '<td>' + name + '</td>' +
    '<td>' + price + '</td>' +
    '<td>' + changeHtml + '</td>' +
    '<td>' + volRatio + '</td>' +
    '<td>' + turnover + '</td>' +
    '<td>' + marketCap + '</td>' +
    '<td>' + limitUpHtml + '</td>' +
    '<td>' + industry + '</td>' +
    '</tr>';
}

/** 格式化数字，保留适当小数位 */
function formatNum(v) {
  if (v === null || v === undefined || v === '') return '--';
  const n = parseFloat(v);
  if (isNaN(n)) return esc(String(v));
  // 如果是接近整数的值，保留 2 位小数
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

/** 格式化时间字符串 */
function formatTime(t) {
  if (!t) return '--';
  try {
    const d = new Date(t);
    if (isNaN(d.getTime())) return esc(String(t));
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return yy + '-' + mm + '-' + dd + ' ' + hh + ':' + mi + ':' + ss;
  } catch (e) {
    return esc(String(t));
  }
}

/** 打开腾讯证券个股详情页 */
function openStockPage(code) {
  var prefix;
  if (code.startsWith('6')) {
    prefix = 'sh';
  } else if (code.startsWith('0') || code.startsWith('3')) {
    prefix = 'sz';
  } else {
    prefix = 'bj';
  }
  window.open('https://gu.qq.com/' + prefix + code, '_blank');
}

// ============================================================
// 骨架屏
// ============================================================

function showSkeleton() {
  skeletonContainer.style.display = 'block';

  let html = '';
  const cols = ['cell-sm', 'cell-md', 'cell-sm', 'cell-sm', 'cell-sm', 'cell-sm', 'cell-md', 'cell-sm', 'cell-lg'];
  for (let i = 0; i < 6; i++) {
    html += '<div class="skeleton-row">';
    for (let j = 0; j < cols.length; j++) {
      html += '<div class="skeleton-cell skeleton-' + cols[j] + '"></div>';
    }
    html += '</div>';
  }
  skeletonContainer.innerHTML = html;
}

// ============================================================
// 错误处理
// ============================================================

function showError(msg) {
  errorMessage.textContent = msg || '未知错误';
  errorPanel.style.display = 'flex';
}

// ============================================================
// CSV 导出
// ============================================================

function exportCSV() {
  const data = state.lastData;
  if (!data || !data.stocks || data.stocks.length === 0) return;

  const stocks = data.stocks;
  const headers = ['代码', '名称', '现价', '涨幅(%)', '量比', '换手率(%)', '市值(亿)', '近20日涨停', '行业'];

  // BOM 确保 Excel 正确识别 UTF-8
  let csv = '﻿';

  // 表头
  csv += headers.map(function (h) { return csvEscape(h); }).join(',') + '\n';

  // 数据行
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    const row = [
      s.code,
      s.name,
      s.price,
      s.change_pct,
      s.volume_ratio,
      s.turnover_rate,
      s.market_cap,
      s.limit_up_count,
      s.sector
    ];
    csv += row.map(function (v) { return csvEscape(v); }).join(',') + '\n';
  }

  // 生成文件名含日期
  const now = new Date();
  const dateStr = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const filename = 'stock_screen_' + dateStr + '.csv';

  // 触发下载
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** CSV 字段转义 */
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // 如果包含逗号、引号或换行，需要用引号包裹
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ============================================================
// 板块资金流向
// ============================================================

/** SVG 火焰图标 */
const FIRE_SVG = '<svg class=\"fire-badge\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"#dc2626\"><path d=\"M12 2c-1.5 2-6 5.5-6 10a6 6 0 1012 0c0-4.5-4.5-8-6-10z\"/><path d=\"M12 22a5 5 0 01-3-9c1 2 3 1.5 3 1.5s1.5 2.5 0 5a5.1 5.1 0 010 2.5z\" fill=\"#f97316\"/></svg>';

async function fetchSectors() {
  try {
    sectorLoading.style.display = 'block';
    sectorError.style.display = 'none';
    sectorList.style.display = 'none';

    const resp = await fetch('/api/sectors');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    lastSectorData = data.sectors || [];
    renderSectors(lastSectorData);
  } catch (err) {
    sectorLoading.style.display = 'none';
    sectorError.style.display = 'block';
    sectorError.textContent = '板块数据加载失败';
  }
}

function renderSectors(sectors) {
  sectorLoading.style.display = 'none';
  sectorList.style.display = 'block';

  if (!sectors || sectors.length === 0) {
    sectorList.innerHTML = '<div style="padding:16px;text-align:center;font-size:0.75rem;color:var(--color-text-muted);">暂无数据</div>';
    return;
  }

  var sorted = sectors.slice().sort(function (a, b) {
    if (sectorSortMode === 'change') {
      return b.change_pct - a.change_pct;
    }
    return b.main_inflow - a.main_inflow;
  });

  // 更新热门板块集合
  hotSectors = new Set();
  for (var i = 0; i < sectors.length; i++) {
    if (sectors[i].hot) {
      hotSectors.add(sectors[i].name);
    }
  }

  var html = '';
  for (var i = 0; i < sorted.length; i++) {
    var s = sorted[i];
    var changeCls = s.change_pct >= 0 ? 'up' : 'down';
    var inflowCls = s.main_inflow >= 0 ? 'in' : 'out';
    var hotCls = s.hot ? ' hot' : '';
    var changeSign = s.change_pct > 0 ? '+' : '';

    html += '<div class=\"sector-item' + hotCls + '\">' +
      '<span class=\"sector-name\">' + esc(s.name) + '</span>' +
      '<span class=\"sector-change ' + changeCls + '\">' + changeSign + esc(String(s.change_pct)) + '%</span>' +
      '<span class=\"sector-inflow ' + inflowCls + '\">' + (s.main_inflow >= 0 ? '+' : '') + esc(String(s.main_inflow)) + '亿</span>' +
      '</div>';
  }
  sectorList.innerHTML = html;
}

function sortSectors(mode) {
  sectorSortMode = mode;
  // 更新按钮状态
  var buttons = document.querySelectorAll('.sort-btn');
  for (var i = 0; i < buttons.length; i++) {
    var btn = buttons[i];
    if (btn.getAttribute('data-sort') === mode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }
  // 用缓存数据重新渲染
  if (typeof lastSectorData !== 'undefined' && lastSectorData) {
    renderSectors(lastSectorData);
  }
}

// 缓存最近一次板块数据，供 sortSectors 使用
var lastSectorData = null;

async function fetchHotIndustries() {
  try {
    var resp = await fetch('/api/hot_industries');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var data = await resp.json();
    renderHotIndustries(data.hot_industries || []);
  } catch (e) {
    if (hotIndustriesList) {
      hotIndustriesList.innerHTML = '<div style="padding:8px;text-align:center;font-size:0.625rem;color:var(--color-text-muted);">热度数据加载失败</div>';
    }
  }
}

function renderHotIndustries(items) {
  if (!hotIndustriesList) return;
  if (!items || items.length === 0) {
    hotIndustriesList.innerHTML = '<div style="padding:8px;text-align:center;font-size:0.625rem;color:var(--color-text-muted);">暂无数据</div>';
    return;
  }

  var top10 = items.slice(0, 10);
  // 用最高热度分做进度条基准
  var maxScore = top10[0].heat_score || 1;

  var html = '';
  for (var i = 0; i < top10.length; i++) {
    var item = top10[i];
    var rank = i + 1;
    var rankCls = rank <= 3 ? ' top3' : '';
    var trendIcon = '→';
    var trendCls = 'stable';
    if (item.trend === 'up') { trendIcon = '↗'; trendCls = 'up'; }
    else if (item.trend === 'down') { trendIcon = '↘'; trendCls = 'down'; }

    var barPct = Math.round((item.heat_score / maxScore) * 100);

    html += '<div class="hot-item">' +
      '<span class="hot-rank' + rankCls + '">' + rank + '</span>' +
      '<span class="hot-name" title="' + esc(item.name) + '">' + esc(item.name) + '</span>' +
      '<span class="hot-score-wrap">' +
        '<span class="hot-score-bar-bg"><span class="hot-score-bar-fill" style="width:' + barPct + '%"></span></span>' +
        '<span class="hot-score-val">' + esc(String(item.heat_score)) + '</span>' +
      '</span>' +
      '<span class="hot-trend ' + trendCls + '">' + trendIcon + '</span>' +
      '<span class="hot-inflow">' + (item.total_inflow_10d >= 0 ? '+' : '') + esc(String(item.total_inflow_10d)) + '亿</span>' +
      '</div>';
  }
  hotIndustriesList.innerHTML = html;
}

async function fetchIndustries() {
  try {
    var resp = await fetch('/api/industries');
    if (!resp.ok) return;
    var data = await resp.json();
    var list = data.industries || [];
    var select = $('#industry-select');
    if (select) {
      while (select.options.length > 1) select.remove(1);
      for (var i = 0; i < list.length; i++) {
        var opt = document.createElement('option');
        opt.value = list[i];
        opt.textContent = list[i];
        select.appendChild(opt);
      }
      select.value = state.selectedIndustry;
    }
  } catch (e) {
    // 静默处理
  }
}

function startAutoRefresh() {
  if (state.autoRefresh.timerId) clearInterval(state.autoRefresh.timerId);
  state.autoRefresh.countdown = state.autoRefresh.interval;
  updateCountdownDisplay();
  state.autoRefresh.timerId = setInterval(function () {
    state.autoRefresh.countdown--;
    updateCountdownDisplay();
    if (state.autoRefresh.countdown <= 0) {
      state.autoRefresh.countdown = state.autoRefresh.interval;
      if (!state.isLoading) {
        doScreen();
      }
    }
  }, 1000);
}

function stopAutoRefresh() {
  if (state.autoRefresh.timerId) {
    clearInterval(state.autoRefresh.timerId);
    state.autoRefresh.timerId = null;
  }
  state.autoRefresh.countdown = 0;
  updateCountdownDisplay();
}

function updateCountdownDisplay() {
  var el = $('#auto-refresh-countdown');
  if (!el) return;
  if (state.autoRefresh.enabled && state.autoRefresh.countdown > 0) {
    el.textContent = state.autoRefresh.countdown + 's';
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

// ============================================================
// 初始化
// ============================================================

function init() {
  renderFilters();
  attachSortHandlers();
  fetchSectors();
  fetchIndustries();
  fetchHotIndustries();
}

document.addEventListener('DOMContentLoaded', init);
