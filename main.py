"""A股选股器 Web 应用（FastAPI + 原生 HTML 前端）."""

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from screener import ScreenRequest, FilterConfig, run_screen, fetch_sector_flows, analyze_hot_industries

app = FastAPI(title="A股选股器")

# 静态文件挂载
app.mount("/static", StaticFiles(directory="static"), name="static")


def _parse_filter(raw: dict, defaults: dict) -> FilterConfig:
    """将请求体中的 filter JSON 转成 FilterConfig 对象.

    Args:
        raw: 请求中传入的筛选条件字典（可能为 None）
        defaults: 默认值字典，包含 enabled/min_val/max_val/extra

    Returns:
        FilterConfig 实例
    """
    if not isinstance(raw, dict):
        raw = {}

    enabled = raw.get("enabled", defaults.get("enabled", True))
    min_val = raw.get("min_val", defaults.get("min_val"))
    max_val = raw.get("max_val", defaults.get("max_val"))
    extra = raw.get("extra", defaults.get("extra", {}))

    # 确保 extra 是 dict
    if not isinstance(extra, dict):
        extra = defaults.get("extra", {})

    return FilterConfig(
        enabled=bool(enabled),
        min_val=float(min_val) if min_val is not None else None,
        max_val=float(max_val) if max_val is not None else None,
        extra=extra,
    )


@app.post("/api/screen")
async def screen(request: Request):
    """执行股票筛选.

    Request body 示例:
    {
        "filters": {
            "change_pct": {"enabled": true, "min_val": 3, "max_val": 5},
            "limit_up": {"enabled": true, "extra": {"days": 20, "min_count": 1}},
            "volume_ratio": {"enabled": true, "min_val": 1},
            "turnover_rate": {"enabled": true, "min_val": 5, "max_val": 10},
            "market_cap": {"enabled": true, "min_val": 50, "max_val": 200}
        }
    }
    """
    body = await request.json()
    filters = body.get("filters", {})

    req = ScreenRequest(
        change_pct=_parse_filter(
            filters.get("change_pct"),
            {"enabled": True, "min_val": 3, "max_val": 5},
        ),
        limit_up=_parse_filter(
            filters.get("limit_up"),
            {"enabled": True, "extra": {"days": 20, "min_count": 1}},
        ),
        limit_up_consolidation=_parse_filter(
            filters.get("limit_up_consolidation"),
            {"enabled": False, "extra": {"days": 20, "min_count": 2, "range_low": -10, "range_high": 5}},
        ),
        volume_ratio=_parse_filter(
            filters.get("volume_ratio"),
            {"enabled": True, "min_val": 1},
        ),
        turnover_rate=_parse_filter(
            filters.get("turnover_rate"),
            {"enabled": True, "min_val": 5, "max_val": 10},
        ),
        market_cap=_parse_filter(
            filters.get("market_cap"),
            {"enabled": True, "min_val": 50, "max_val": 200},
        ),
    )

    result = run_screen(req)
    return result


@app.get("/api/sectors")
async def sectors():
    """返回板块资金流向数据."""
    return {"sectors": fetch_sector_flows()}


@app.get("/api/industries")
async def industries():
    """返回所有可用的行业列表（从缓存文件去重并排序）."""
    import json as _json
    from pathlib import Path
    cache_file = Path(__file__).parent / ".sector_cache.json"
    industry_set = set()
    if cache_file.exists():
        try:
            data = _json.loads(cache_file.read_text(encoding="utf-8"))
            for v in data.values():
                if v and isinstance(v, str) and v.strip():
                    industry_set.add(v.strip())
        except (_json.JSONDecodeError, OSError):
            pass
    return {"industries": sorted(industry_set)}


@app.get("/api/hot_industries")
async def hot_industries():
    """返回10日热门行业分析（热度分、趋势、持续性）."""
    return {"hot_industries": analyze_hot_industries()}


@app.get("/")
async def index():
    """返回前端页面."""
    with open("static/index.html", encoding="utf-8") as f:
        return HTMLResponse(f.read())
