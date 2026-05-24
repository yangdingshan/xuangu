# A股选股器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Web 端 A 股实时选股筛选器，支持五个可配置筛选条件，通过 AKShare 获取数据，FastAPI 后端 + 原生前端。

**Architecture:** FastAPI 异步后端提供 REST API，screener.py 封装 AKShare 数据获取和多条件过滤逻辑，前端单页 HTML 通过 fetch 调用 API 并渲染结果表格。

**Tech Stack:** Python 3, FastAPI, uvicorn, AKShare, pandas, 原生 HTML/CSS/JavaScript

---

### Task 1: 项目初始化

**Files:**
- Create: `requirements.txt`
- Create: `.gitignore`

- [ ] **Step 1: 创建 requirements.txt**

```txt
fastapi==0.115.6
uvicorn==0.34.0
akshare>=1.16.0
pandas>=2.0.0
```

Write `requirements.txt` with the content above.

- [ ] **Step 2: 创建 .gitignore**

```gitignore
__pycache__/
*.pyc
.superpowers/
venv/
.venv/
*.egg-info/
dist/
```

Write `.gitignore` with the content above.

- [ ] **Step 3: 安装依赖**

Run: `pip install -r requirements.txt`

Expected: 所有依赖安装成功，无报错。

- [ ] **Step 4: 验证 AKShare 可用**

Run: `python -c "import akshare as ak; df = ak.stock_zh_a_spot_em(); print('OK:', len(df), 'stocks')"`

Expected: 输出 A 股总数，大约 5000+ 只。

- [ ] **Step 5: Commit**

```bash
git add requirements.txt .gitignore
git commit -m "chore: init project with dependencies"
```

---

### Task 2: 筛选数据模型与过滤器

**Files:**
- Create: `screener.py`

- [ ] **Step 1: 定义筛选条件模型**

在 `screener.py` 中写入以下完整内容：

```python
"""A股选股器核心逻辑：数据获取与条件过滤."""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class FilterConfig:
    """单个筛选条件的配置."""
    enabled: bool
    min_val: Optional[float] = None
    max_val: Optional[float] = None
    extra: dict = field(default_factory=dict)


@dataclass
class ScreenRequest:
    """一次筛选请求的完整参数."""
    change_pct: FilterConfig    # 涨幅
    limit_up: FilterConfig      # 涨停历史 (extra: {"days": N, "min_count": N})
    volume_ratio: FilterConfig  # 量比
    turnover_rate: FilterConfig # 换手率
    market_cap: FilterConfig    # 市值(亿)


@dataclass
class StockInfo:
    """单只股票筛选结果."""
    code: str
    name: str
    price: float
    change_pct: float
    volume_ratio: float
    turnover_rate: float
    market_cap: float
    limit_up_count: int
    sector: str
```

- [ ] **Step 2: 验证模型可实例化**

Run: `python -c "from screener import ScreenRequest, FilterConfig, StockInfo; r = ScreenRequest(change_pct=FilterConfig(enabled=True, min_val=3, max_val=5), limit_up=FilterConfig(enabled=True, extra={'days': 20, 'min_count': 1}), volume_ratio=FilterConfig(enabled=True, min_val=1), turnover_rate=FilterConfig(enabled=True, min_val=5, max_val=10), market_cap=FilterConfig(enabled=True, min_val=50, max_val=200)); print('OK:', r)"`

Expected: `OK: ScreenRequest(...)` 无报错。

- [ ] **Step 3: Commit**

```bash
git add screener.py
git commit -m "feat: add filter config and stock info data models"
```

---

### Task 3: AKShare 数据获取

**Files:**
- Modify: `screener.py`

- [ ] **Step 1: 添加实时行情获取函数**

在 `screener.py` 末尾追加：

```python
import akshare as ak
import pandas as pd
from datetime import datetime, timedelta
from typing import Dict


def fetch_spot_data() -> pd.DataFrame:
    """获取沪深京 A 股实时行情数据.

    Returns:
        DataFrame with columns: 代码, 名称, 最新价, 涨跌幅, 量比,
        换手率, 总市值, 行业
    """
    df = ak.stock_zh_a_spot_em()
    df = df.rename(columns={
        "代码": "code",
        "名称": "name",
        "最新价": "price",
        "涨跌幅": "change_pct",
        "量比": "volume_ratio",
        "换手率": "turnover_rate",
        "总市值": "market_cap",
    })
    # 市值从元转换为亿
    if "market_cap" in df.columns:
        df["market_cap"] = df["market_cap"] / 1e8
    # 只保留需要的列
    cols = ["code", "name", "price", "change_pct", "volume_ratio",
            "turnover_rate", "market_cap"]
    # 行业列可能不存在，尝试查找
    sector_col = None
    for c in df.columns:
        if "行业" in str(c):
            sector_col = c
            cols.append(c)
            break
    df = df[cols]
    if sector_col:
        df = df.rename(columns={sector_col: "sector"})
    else:
        df["sector"] = ""
    return df
```

- [ ] **Step 2: 验证实时行情函数**

Run: `python -c "from screener import fetch_spot_data; df = fetch_spot_data(); print('Columns:', df.columns.tolist()); print('Rows:', len(df)); print(df.head(2))"`

Expected: 输出列名和行数（约5000+），无报错。

- [ ] **Step 3: 添加涨停历史获取函数**

在 `screener.py` 末尾追加：

```python
def fetch_limit_up_history(lookback_days: int = 20) -> Dict[str, int]:
    """获取近 N 个交易日内每只股票的涨停次数.

    Args:
        lookback_days: 回溯天数

    Returns:
        dict: {股票代码: 涨停次数}
    """
    limit_up_count: Dict[str, int] = {}
    # 获取最近 N 个交易日
    trade_dates = ak.tool_trade_date_hist_sina()
    if "trade_date" in trade_dates.columns:
        dates = sorted(trade_dates["trade_date"].tolist(), reverse=True)[:lookback_days]
    else:
        # fallback: 用最近自然日近似
        today = datetime.now()
        dates = [(today - timedelta(days=i)).strftime("%Y%m%d") for i in range(lookback_days * 2)]
        dates = dates[:lookback_days]

    for date_str in dates:
        try:
            zt_df = ak.stock_zt_pool_em(date=date_str)
            if zt_df is not None and not zt_df.empty:
                code_col = None
                for c in zt_df.columns:
                    if "代码" in str(c):
                        code_col = c
                        break
                if code_col:
                    for code in zt_df[code_col]:
                        limit_up_count[code] = limit_up_count.get(code, 0) + 1
        except Exception:
            continue  # 非交易日或数据不可用，跳过

    return limit_up_count
```

- [ ] **Step 4: 验证涨停历史函数**

Run: `python -c "from screener import fetch_limit_up_history; counts = fetch_limit_up_history(5); print('Sample:', list(counts.items())[:5], 'Total codes:', len(counts))"`

Expected: 输出部分股票代码及其涨停次数，总数可能为0（非交易日）或有数据。

- [ ] **Step 5: Commit**

```bash
git add screener.py
git commit -m "feat: add AKShare data fetching for spot and limit-up"
```

---

### Task 4: 筛选逻辑

**Files:**
- Modify: `screener.py`

- [ ] **Step 1: 添加筛选函数**

在 `screener.py` 末尾追加：

```python
def apply_filters(df: pd.DataFrame, req: ScreenRequest,
                  limit_up_counts: Dict[str, int]) -> list[StockInfo]:
    """对行情数据应用筛选条件，返回符合条件的股票列表.

    Args:
        df: 实时行情 DataFrame
        req: 筛选请求参数
        limit_up_counts: 涨停次数映射

    Returns:
        符合条件的 StockInfo 列表
    """
    mask = pd.Series(True, index=df.index)

    # 涨幅过滤
    if req.change_pct.enabled:
        lo = req.change_pct.min_val if req.change_pct.min_val is not None else -100
        hi = req.change_pct.max_val if req.change_pct.max_val is not None else 100
        mask &= (df["change_pct"] >= lo) & (df["change_pct"] <= hi)

    # 量比过滤
    if req.volume_ratio.enabled:
        lo = req.volume_ratio.min_val if req.volume_ratio.min_val is not None else 0
        mask &= (df["volume_ratio"] >= lo)

    # 换手率过滤
    if req.turnover_rate.enabled:
        lo = req.turnover_rate.min_val if req.turnover_rate.min_val is not None else 0
        hi = req.turnover_rate.max_val if req.turnover_rate.max_val is not None else 100
        mask &= (df["turnover_rate"] >= lo) & (df["turnover_rate"] <= hi)

    # 市值过滤
    if req.market_cap.enabled:
        lo = req.market_cap.min_val if req.market_cap.min_val is not None else 0
        hi = req.market_cap.max_val if req.market_cap.max_val is not None else float("inf")
        mask &= (df["market_cap"] >= lo) & (df["market_cap"] <= hi)

    filtered = df[mask]

    # 涨停过滤 (在缩小范围后检查)
    if req.limit_up.enabled:
        min_count = req.limit_up.extra.get("min_count", 1)
        valid_codes = [
            code for code, count in limit_up_counts.items()
            if count >= min_count
        ]
        filtered = filtered[filtered["code"].isin(valid_codes)]

    # 转为 StockInfo 列表
    results = []
    for _, row in filtered.iterrows():
        code = str(row["code"])
        results.append(StockInfo(
            code=code,
            name=str(row.get("name", "")),
            price=float(row.get("price", 0) or 0),
            change_pct=float(row.get("change_pct", 0) or 0),
            volume_ratio=float(row.get("volume_ratio", 0) or 0),
            turnover_rate=float(row.get("turnover_rate", 0) or 0),
            market_cap=float(row.get("market_cap", 0) or 0),
            limit_up_count=limit_up_counts.get(code, 0),
            sector=str(row.get("sector", "")),
        ))
    return results
```

- [ ] **Step 2: 添加顶层 run_screen 函数**

在 `screener.py` 末尾追加：

```python
def run_screen(req: ScreenRequest) -> dict:
    """执行一次完整筛选.

    Returns:
        {"total_scanned": int, "matched": int,
         "updated_at": str, "stocks": list[dict]}
    """
    df = fetch_spot_data()
    total = len(df)

    limit_up_counts = {}
    if req.limit_up.enabled:
        days = req.limit_up.extra.get("days", 20)
        limit_up_counts = fetch_limit_up_history(lookback_days=days)

    stocks = apply_filters(df, req, limit_up_counts)

    return {
        "total_scanned": total,
        "matched": len(stocks),
        "updated_at": datetime.now().strftime("%H:%M:%S"),
        "stocks": [
            {
                "code": s.code,
                "name": s.name,
                "price": s.price,
                "change_pct": s.change_pct,
                "volume_ratio": s.volume_ratio,
                "turnover_rate": s.turnover_rate,
                "market_cap": round(s.market_cap, 1),
                "limit_up_count": s.limit_up_count,
                "sector": s.sector,
            }
            for s in stocks
        ],
    }
```

- [ ] **Step 3: 验证筛选逻辑**

Run: `python -c "from screener import ScreenRequest, FilterConfig, run_screen; req = ScreenRequest(change_pct=FilterConfig(True, 1, 5), limit_up=FilterConfig(False), volume_ratio=FilterConfig(True, min_val=0.5), turnover_rate=FilterConfig(False), market_cap=FilterConfig(False)); result = run_screen(req); print('Scanned:', result['total_scanned'], 'Matched:', result['matched'])"`

Expected: 输出扫描总数和符合条件数，无报错。

- [ ] **Step 4: Commit**

```bash
git add screener.py
git commit -m "feat: add filter logic and run_screen pipeline"
```

---

### Task 5: FastAPI 应用与 API 端点

**Files:**
- Create: `main.py`

- [ ] **Step 1: 创建 FastAPI 应用**

```python
"""A股选股器 Web 应用."""

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from screener import ScreenRequest, FilterConfig, run_screen

app = FastAPI(title="A股选股器")


@app.post("/api/screen")
async def screen(request: Request):
    """执行股票筛选."""
    body = await request.json()
    filters = body.get("filters", {})

    req = ScreenRequest(
        change_pct=FilterConfig(**filters.get("change_pct", {"enabled": True, "min_val": 3, "max_val": 5})),
        limit_up=FilterConfig(**filters.get("limit_up", {"enabled": True, "extra": {"days": 20, "min_count": 1}})),
        volume_ratio=FilterConfig(**filters.get("volume_ratio", {"enabled": True, "min_val": 1})),
        turnover_rate=FilterConfig(**filters.get("turnover_rate", {"enabled": True, "min_val": 5, "max_val": 10})),
        market_cap=FilterConfig(**filters.get("market_cap", {"enabled": True, "min_val": 50, "max_val": 200})),
    )

    result = run_screen(req)
    return result


@app.get("/")
async def index():
    """返回前端页面."""
    with open("static/index.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())
```

Write `main.py` with the content above.

- [ ] **Step 2: 创建静态目录和占位文件**

```bash
mkdir -p static && touch static/index.html static/style.css static/app.js
```

- [ ] **Step 3: 验证应用能启动**

Run: `python -c "from main import app; print('FastAPI app:', app.title)"`

Expected: `FastAPI app: A股选股器`

- [ ] **Step 4: Commit**

```bash
git add main.py static/
git commit -m "feat: add FastAPI app with /api/screen endpoint"
```

---

### Task 6: 前端 HTML 页面

**Files:**
- Modify: `static/index.html`

- [ ] **Step 1: 创建完整 HTML 页面**

Write `static/index.html` with the following content:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>A股选股器</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>

<div class="app">

  <!-- Filter Bar -->
  <div class="panel filter-bar" id="filterBar"></div>

  <!-- Stats Row -->
  <div class="stats-row" id="statsRow">
    <div class="panel stat-card">
      <div class="stat-value" id="statTotal">--</div>
      <div class="stat-label">扫描总数</div>
    </div>
    <div class="panel stat-card">
      <div class="stat-value accent" id="statMatched">--</div>
      <div class="stat-label">符合条件</div>
    </div>
    <div class="panel stat-card">
      <div class="stat-value" id="statTime" style="font-size:22px">--</div>
      <div class="stat-label">更新时间</div>
    </div>
    <div class="panel stat-card">
      <div class="stat-value" id="statRate" style="font-size:22px">--</div>
      <div class="stat-label">选中率</div>
    </div>
  </div>

  <!-- Results Table -->
  <div class="panel" id="resultsPanel" style="display:none">
    <div class="table-header-bar">
      <span>筛选结果 <span class="count" id="resultCount"></span></span>
      <button class="btn btn-secondary btn-sm" id="exportBtn" onclick="exportCSV()">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v10l5-3 5 3V3a2 2 0 00-2-2H5a2 2 0 00-2 2z"/></svg>
        导出 CSV
      </button>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>代码</th><th>名称</th><th>现价</th><th>涨幅</th>
            <th>量比</th><th>换手率</th><th>市值 (亿)</th>
            <th>近20日涨停</th><th>行业</th>
          </tr>
        </thead>
        <tbody id="tableBody"></tbody>
      </table>
      <div class="empty-state" id="emptyState" style="display:none">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M8 11h6"/></svg>
        <p class="empty-title">没有符合条件的股票</p>
        <p class="empty-desc">建议放宽筛选条件后重试</p>
      </div>
    </div>
  </div>

  <!-- Loading -->
  <div class="panel loading-panel" id="loadingPanel" style="display:none">
    <div class="skeleton"></div>
    <div class="skeleton"></div>
    <div class="skeleton"></div>
    <div class="skeleton" style="width:60%"></div>
    <div class="skeleton"></div>
  </div>

  <!-- Error -->
  <div class="panel error-panel" id="errorPanel" style="display:none">
    <div class="error-inner">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <div>
        <p class="error-title">数据获取异常</p>
        <p class="error-desc" id="errorMsg">实时行情接口超时，请检查网络后重试。</p>
        <button class="btn btn-secondary btn-sm" onclick="doScreen()">重新获取</button>
      </div>
    </div>
  </div>

</div>

<script src="/static/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 验证 HTML 可正常返回**

启动应用后访问 `http://localhost:8000`，应看到页面框架。

- [ ] **Step 3: Commit**

```bash
git add static/index.html
git commit -m "feat: add HTML page structure"
```

---

### Task 7: 前端 CSS 样式

**Files:**
- Modify: `static/style.css`

- [ ] **Step 1: 创建完整 CSS**

Write `static/style.css` with the following content:

```css
/* ===== Reset & Base ===== */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #fafbfc;
  --surface: #ffffff;
  --border: #e2e8f0;
  --text: #1a202c;
  --text-secondary: #64748b;
  --accent: #0f766e;
  --red: #dc2626;
  --orange: #d97706;
  --blue: #2563eb;
  --header-bg: #1e293b;
  --row-alt: #f8fafc;
  --radius: 12px;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}

.app {
  max-width: 1400px;
  margin: 0 auto;
  padding: 24px 32px;
}

/* ===== Panel ===== */
.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

/* ===== Filter Bar ===== */
.filter-bar {
  padding: 20px 24px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.filter-groups {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  white-space: nowrap;
  transition: background 0.2s, border-color 0.2s;
}
.filter-group.disabled { background: #fafafa; border-color: #f1f5f9; }
.filter-group.disabled .filter-label { color: #94a3b8; }

.filter-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.filter-unit { font-size: 11px; color: var(--text-secondary); }

/* Toggle */
.toggle-track {
  width: 40px; height: 22px;
  border-radius: 100px;
  background: #cbd5e1;
  position: relative;
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}
.toggle-track.on { background: var(--accent); }
.toggle-knob {
  width: 18px; height: 18px;
  border-radius: 50%;
  background: #fff;
  position: absolute;
  top: 2px; left: 2px;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
}
.toggle-track.on .toggle-knob { transform: translateX(18px); }

/* Filter Inputs */
.filter-input {
  width: 52px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  text-align: center;
  font-family: "JetBrains Mono", "Fira Code", monospace;
  color: var(--text);
  background: #fff;
  transition: border-color 0.15s;
}
.filter-input:disabled { background: #f1f5f9; color: #94a3b8; cursor: not-allowed; }
.filter-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(15,118,110,0.15); }
.filter-input-sm { width: 44px; }

.hint-text {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 8px;
}

/* ===== Buttons ===== */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  border-radius: 100px;
  font-size: 14px;
  font-weight: 600;
  background: var(--accent);
  color: #fff;
  border: none;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
  box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.1);
  flex-shrink: 0;
}
.btn:active { transform: scale(0.97); }
.btn-secondary {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  box-shadow: none;
}
.btn-sm { padding: 6px 14px; font-size: 12px; }

/* ===== Stats ===== */
.stats-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}
.stat-card { padding: 18px 20px; }
.stat-value {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1;
  color: var(--text);
}
.stat-value.accent { color: var(--accent); }
.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* ===== Table ===== */
.table-header-bar {
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  font-size: 14px;
}
.count { font-weight: 400; color: #64748b; }
.table-wrap { overflow-x: auto; }

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.data-table th {
  background: var(--header-bg);
  color: #e2e8f0;
  padding: 12px 12px;
  text-align: left;
  font-weight: 500;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.data-table td {
  padding: 12px 12px;
  border-bottom: 1px solid #f1f5f9;
  color: var(--text);
}
.data-table tr:nth-child(even) td { background: var(--row-alt); }
.data-table tr:hover td { background: #eff6ff; }
.data-table .code { color: var(--blue); font-weight: 600; }
.data-table .rise { color: var(--red); font-weight: 600; }
.data-table .limit-up { color: var(--orange); font-weight: 600; }
.data-table .sector { color: var(--text-secondary); }

/* ===== States ===== */
.loading-panel { padding: 20px; }

.skeleton {
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  margin-bottom: 10px;
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.empty-state {
  text-align: center;
  padding: 64px 24px;
  color: var(--text-secondary);
}
.empty-state svg { opacity: 0.3; margin-bottom: 16px; }
.empty-title { font-weight: 600; font-size: 15px; color: #475569; margin-bottom: 4px; }
.empty-desc { font-size: 13px; }

.error-panel { border-left: 3px solid #dc2626; margin-bottom: 16px; }
.error-inner {
  padding: 20px 24px;
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.error-title { font-weight: 600; font-size: 14px; color: #1a202c; }
.error-desc { font-size: 13px; color: #64748b; margin: 4px 0 8px; }

/* ===== Responsive ===== */
@media (max-width: 768px) {
  .app { padding: 16px; }
  .stats-row { grid-template-columns: 1fr 1fr; }
  .filter-bar { flex-direction: column; align-items: stretch; }
}
```

- [ ] **Step 2: 验证服务器配置**

确保 `main.py` 中配置了静态文件服务。如果尚未添加，在 `main.py` 中 `app = FastAPI(...)` 之后添加：

```python
app.mount("/static", StaticFiles(directory="static"), name="static")
```

- [ ] **Step 3: Commit**

```bash
git add static/style.css
git commit -m "feat: add CSS styles with design-taste-frontend palette"
```

---

### Task 8: 前端 JavaScript 交互

**Files:**
- Modify: `static/app.js`

- [ ] **Step 1: 创建完整 JS 逻辑**

Write `static/app.js` with the following content:

```javascript
// ===== Default Filter State =====
const DEFAULT_FILTERS = {
  change_pct:   { enabled: true, min_val: 3, max_val: 5 },
  limit_up:     { enabled: true, extra: { days: 20, min_count: 1 } },
  volume_ratio: { enabled: true, min_val: 1 },
  turnover_rate:{ enabled: true, min_val: 5, max_val: 10 },
  market_cap:   { enabled: true, min_val: 50, max_val: 200 }
};

let currentFilters = loadFilters();
let lastResult = null;

function loadFilters() {
  try {
    const saved = localStorage.getItem('stockScreenerFilters');
    if (saved) return JSON.parse(saved);
  } catch (e) { /* ignore */ }
  return JSON.parse(JSON.stringify(DEFAULT_FILTERS));
}

function saveFilters() {
  localStorage.setItem('stockScreenerFilters', JSON.stringify(currentFilters));
}

// ===== Render Filter Bar =====
function renderFilters() {
  const container = document.getElementById('filterBar');
  container.innerHTML = '';

  const groups = document.createElement('div');
  groups.className = 'filter-groups';

  // 涨幅
  groups.appendChild(buildRangeFilter('change_pct', '涨幅', '%'));
  // 涨停
  groups.appendChild(buildLimitUpFilter());
  // 量比
  groups.appendChild(buildSingleFilter('volume_ratio', '量比', 'min_val'));
  // 换手率
  groups.appendChild(buildRangeFilter('turnover_rate', '换手率', '%'));
  // 市值
  groups.appendChild(buildRangeFilter('market_cap', '市值', '亿', 'sm'));

  container.appendChild(groups);

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1l5.5 5.5v5.5l3-2v-3.5L15 1z"/></svg>开始筛选`;
  btn.onclick = doScreen;
  container.appendChild(btn);

  const hint = document.createElement('p');
  hint.className = 'hint-text';
  hint.textContent = '关闭开关后该条件不参与筛选；参数自动保存';
  hint.style.width = '100%';
  container.appendChild(hint);
}

function buildRangeFilter(key, label, unit, sizeClass) {
  const f = currentFilters[key];
  const div = document.createElement('div');
  div.className = 'filter-group' + (f.enabled ? '' : ' disabled');

  div.appendChild(makeToggle((v) => {
    currentFilters[key].enabled = v;
    saveFilters();
    renderFilters();
  }, f.enabled));

  const lbl = document.createElement('span');
  lbl.className = 'filter-label';
  lbl.textContent = label;
  div.appendChild(lbl);

  const minInput = makeInput(f.min_val, (v) => { currentFilters[key].min_val = v; saveFilters(); }, f.enabled, sizeClass);
  div.appendChild(minInput);

  if (unit) {
    const u = document.createElement('span');
    u.className = 'filter-unit';
    u.textContent = unit;
    div.appendChild(u);
  }

  const sep = document.createElement('span');
  sep.style.cssText = 'color:#94a3b8;font-size:13px;';
  sep.textContent = '~';
  div.appendChild(sep);

  const maxInput = makeInput(f.max_val, (v) => { currentFilters[key].max_val = v; saveFilters(); }, f.enabled, sizeClass);
  div.appendChild(maxInput);

  if (unit) {
    const u2 = document.createElement('span');
    u2.className = 'filter-unit';
    u2.textContent = unit;
    div.appendChild(u2);
  }

  return div;
}

function buildSingleFilter(key, label, field) {
  const f = currentFilters[key];
  const div = document.createElement('div');
  div.className = 'filter-group' + (f.enabled ? '' : ' disabled');

  div.appendChild(makeToggle((v) => {
    currentFilters[key].enabled = v;
    saveFilters();
    renderFilters();
  }, f.enabled));

  const lbl = document.createElement('span');
  lbl.className = 'filter-label';
  lbl.textContent = label;
  div.appendChild(lbl);

  const ge = document.createElement('span');
  ge.style.cssText = 'color:#94a3b8;font-size:13px;';
  ge.textContent = '≥';
  div.appendChild(ge);

  const inp = makeInput(f[field], (v) => { currentFilters[key][field] = v; saveFilters(); }, f.enabled);
  div.appendChild(inp);

  return div;
}

function buildLimitUpFilter() {
  const f = currentFilters.limit_up;
  const div = document.createElement('div');
  div.className = 'filter-group' + (f.enabled ? '' : ' disabled');

  div.appendChild(makeToggle((v) => {
    currentFilters.limit_up.enabled = v;
    saveFilters();
    renderFilters();
  }, f.enabled));

  const lbl = document.createElement('span');
  lbl.className = 'filter-label';
  lbl.textContent = '涨停';
  div.appendChild(lbl);

  const p1 = document.createElement('span');
  p1.className = 'filter-unit';
  p1.textContent = '近';
  div.appendChild(p1);

  const daysInput = makeInput(f.extra.days, (v) => { currentFilters.limit_up.extra.days = v; saveFilters(); }, f.enabled, 'sm');
  div.appendChild(daysInput);

  const p2 = document.createElement('span');
  p2.className = 'filter-unit';
  p2.textContent = '日';
  div.appendChild(p2);

  const ge = document.createElement('span');
  ge.style.cssText = 'color:#94a3b8;font-size:13px;';
  ge.textContent = '≥';
  div.appendChild(ge);

  const cntInput = makeInput(f.extra.min_count, (v) => { currentFilters.limit_up.extra.min_count = v; saveFilters(); }, f.enabled, 'sm');
  div.appendChild(cntInput);

  const p3 = document.createElement('span');
  p3.className = 'filter-unit';
  p3.textContent = '次';
  div.appendChild(p3);

  return div;
}

function makeToggle(onChange, initial) {
  const track = document.createElement('div');
  track.className = 'toggle-track' + (initial ? ' on' : '');
  const knob = document.createElement('div');
  knob.className = 'toggle-knob';
  track.appendChild(knob);
  track.onclick = () => {
    const newState = !track.classList.contains('on');
    track.classList.toggle('on');
    onChange(newState);
  };
  return track;
}

function makeInput(value, onChange, enabled, sizeClass) {
  const inp = document.createElement('input');
  inp.type = 'number';
  inp.step = 'any';
  inp.className = 'filter-input' + (sizeClass ? ' filter-input-' + sizeClass : '');
  inp.value = value;
  inp.disabled = !enabled;
  inp.addEventListener('change', () => onChange(parseFloat(inp.value) || 0));
  return inp;
}

// ===== API Call =====
async function doScreen() {
  const lp = document.getElementById('loadingPanel');
  const rp = document.getElementById('resultsPanel');
  const ep = document.getElementById('errorPanel');

  lp.style.display = '';
  rp.style.display = 'none';
  ep.style.display = 'none';
  document.getElementById('statsRow').style.display = 'none';

  try {
    const resp = await fetch('/api/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: currentFilters })
    });

    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const data = await resp.json();
    lastResult = data;
    renderResults(data);

  } catch (err) {
    lp.style.display = 'none';
    ep.style.display = '';
    document.getElementById('errorMsg').textContent = err.message || '网络请求失败，请检查服务是否启动。';
  }
}

// ===== Render Results =====
function renderResults(data) {
  document.getElementById('loadingPanel').style.display = 'none';
  document.getElementById('errorPanel').style.display = 'none';
  document.getElementById('statsRow').style.display = '';

  document.getElementById('statTotal').textContent = data.total_scanned.toLocaleString();
  document.getElementById('statMatched').textContent = data.matched;
  document.getElementById('statTime').textContent = data.updated_at;
  const rate = data.total_scanned > 0 ? (data.matched / data.total_scanned * 100).toFixed(2) : '0.00';
  document.getElementById('statRate').innerHTML = rate + '<span style="font-size:14px;font-weight:400;color:#64748b">%</span>';

  const rp = document.getElementById('resultsPanel');
  rp.style.display = '';
  document.getElementById('resultCount').textContent = data.matched + ' 只';

  const tbody = document.getElementById('tableBody');
  const empty = document.getElementById('emptyState');

  if (data.matched === 0) {
    tbody.innerHTML = '';
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
    tbody.innerHTML = data.stocks.map(s => `
      <tr>
        <td class="code">${esc(s.code)}</td>
        <td style="font-weight:600">${esc(s.name)}</td>
        <td>${s.price.toFixed(2)}</td>
        <td class="rise">${s.change_pct > 0 ? '+' : ''}${s.change_pct.toFixed(2)}%</td>
        <td>${s.volume_ratio.toFixed(2)}</td>
        <td>${s.turnover_rate.toFixed(2)}%</td>
        <td>${s.market_cap.toFixed(1)}</td>
        <td class="limit-up">${s.limit_up_count}次</td>
        <td class="sector">${esc(s.sector)}</td>
      </tr>
    `).join('');
  }
}

function esc(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function exportCSV() {
  if (!lastResult || !lastResult.stocks.length) return;
  const headers = ['代码','名称','现价','涨幅','量比','换手率','市值(亿)','近20日涨停','行业'];
  const rows = lastResult.stocks.map(s =>
    [s.code, s.name, s.price, s.change_pct, s.volume_ratio, s.turnover_rate, s.market_cap, s.limit_up_count, s.sector]
  );
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stock_screen_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ===== Init =====
renderFilters();
```

- [ ] **Step 2: 验证 JS 语法**

在浏览器 Console 中打开页面，检查是否有 JS 报错。

- [ ] **Step 3: Commit**

```bash
git add static/app.js
git commit -m "feat: add frontend JS with filter toggle and API integration"
```

---

### Task 9: 集成测试与最终验证

**Files:**
- Modify: `main.py` (确保静态文件挂载配置正确)

- [ ] **Step 1: 确认 main.py 完整**

`main.py` 最终内容应为：

```python
"""A股选股器 Web 应用."""

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from screener import ScreenRequest, FilterConfig, run_screen

app = FastAPI(title="A股选股器")

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.post("/api/screen")
async def screen(request: Request):
    """执行股票筛选."""
    body = await request.json()
    filters = body.get("filters", {})

    req = ScreenRequest(
        change_pct=FilterConfig(**filters.get("change_pct", {"enabled": True, "min_val": 3, "max_val": 5})),
        limit_up=FilterConfig(**filters.get("limit_up", {"enabled": True, "extra": {"days": 20, "min_count": 1}})),
        volume_ratio=FilterConfig(**filters.get("volume_ratio", {"enabled": True, "min_val": 1})),
        turnover_rate=FilterConfig(**filters.get("turnover_rate", {"enabled": True, "min_val": 5, "max_val": 10})),
        market_cap=FilterConfig(**filters.get("market_cap", {"enabled": True, "min_val": 50, "max_val": 200})),
    )

    result = run_screen(req)
    return result


@app.get("/")
async def index():
    """返回前端页面."""
    with open("static/index.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())
```

- [ ] **Step 2: 启动应用**

Run: `uvicorn main:app --host 0.0.0.0 --port 8000`

Expected: 服务启动，输出 `Uvicorn running on http://0.0.0.0:8000`

- [ ] **Step 3: 验证 API 端点**

Run: `curl -X POST http://localhost:8000/api/screen -H "Content-Type: application/json" -d "{\"filters\":{\"change_pct\":{\"enabled\":true,\"min_val\":1,\"max_val\":5},\"limit_up\":{\"enabled\":false},\"volume_ratio\":{\"enabled\":false},\"turnover_rate\":{\"enabled\":false},\"market_cap\":{\"enabled\":false}}}"`

Expected: 返回 JSON，包含 `total_scanned`, `matched`, `stocks` 等字段。

- [ ] **Step 4: 验证前端页面**

浏览器打开 `http://localhost:8000`，确认：
- 筛选条件栏显示五组条件，toggle 可开关
- 点击「开始筛选」后显示骨架屏，然后展示结果
- 关闭某条件后再筛选，数据正确变化
- 导出 CSV 功能正常

- [ ] **Step 5: Commit**

```bash
git add main.py
git commit -m "chore: finalize main.py with static mount"
```

---

### Task 10: 运行验证

- [ ] **Step 1: 启动服务并完整走通流程**

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

浏览器打开 `http://localhost:8000`，执行以下验证：
1. 页面加载正确，五组筛选条件显示
2. 点击 toggle 可开关条件，开关后输入框置灰
3. 修改参数值后刷新页面，参数保留（localStorage）
4. 点击「开始筛选」，骨架屏出现，结果表格渲染
5. 点击「导出 CSV」，下载文件内容正确
6. 关闭所有条件（放宽），应返回更多结果

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: final verification and cleanup"
```
