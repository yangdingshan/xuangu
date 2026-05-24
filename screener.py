"""A股选股器核心逻辑."""

import os
import json
import time
import requests
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Tuple
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
import pandas as pd

# ============================================================
# 绕过 Windows 系统代理（必须在最前面设置）
# ============================================================
os.environ['NO_PROXY'] = '*'
os.environ['no_proxy'] = '*'


# ============================================================
# 数据模型
# ============================================================

@dataclass
class FilterConfig:
    """单个筛选条件的配置."""
    enabled: bool = True
    min_val: Optional[float] = None
    max_val: Optional[float] = None
    extra: dict = field(default_factory=dict)


@dataclass
class ScreenRequest:
    """一次筛选请求."""
    change_pct: FilterConfig = field(default_factory=FilterConfig)
    limit_up: FilterConfig = field(default_factory=FilterConfig)
    limit_up_consolidation: FilterConfig = field(default_factory=FilterConfig)
    volume_ratio: FilterConfig = field(default_factory=FilterConfig)
    turnover_rate: FilterConfig = field(default_factory=FilterConfig)
    market_cap: FilterConfig = field(default_factory=FilterConfig)


@dataclass
class StockInfo:
    """单只股票信息."""
    code: str
    name: str
    price: float
    change_pct: float
    volume_ratio: float
    turnover_rate: float
    market_cap: float
    limit_up_count: int
    sector: str


# ============================================================
# 工具函数
# ============================================================

def _create_session():
    """创建绕过系统代理的 requests session."""
    s = requests.Session()
    s.trust_env = False
    s.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://gu.qq.com/',
    })
    return s


def _get_market(code: str) -> int:
    """根据代码判断市场：1=上海, 0=深圳（含创业板/科创板/北交所）."""
    if code.startswith('6'):
        return 1  # 上海
    return 0  # 深圳（含创业板 0/3、科创板 68、北交所 4/8/9）


def _get_limit_threshold(code: str) -> float:
    """根据股票代码返回涨停判断阈值（涨跌幅百分比）."""
    if code.startswith(('30', '68')):
        # 创业板 30xxxx、科创板 68xxxx：20% 涨停
        return 19.8
    elif code.startswith(('8', '4')):
        # 北交所：30% 涨停
        return 29.8
    else:
        # 主板：10% 涨停
        return 9.8


# ============================================================
# 股票代码列表获取
# ============================================================

def get_stock_list() -> pd.DataFrame:
    """获取A股代码和名称列表，缓存到文件避免重复慢速请求."""
    cache_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".stock_cache.json")

    if os.path.exists(cache_file):
        mtime = os.path.getmtime(cache_file)
        # 缓存1小时有效
        if time.time() - mtime < 3600:
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data:
                    return pd.DataFrame(data)
            except (json.JSONDecodeError, ValueError):
                pass  # 缓存损坏，重新获取

    import akshare as ak
    df = ak.stock_zh_a_spot()  # Sina 数据源，约40秒，~5500只股票

    # 列名可能是乱码，按位置取值：第0列=代码，第1列=名称
    cols = df.columns.tolist()
    codes_raw = df[cols[0]].astype(str)
    # AKShare Sina 数据源返回带市场前缀的代码（sh600519, sz000625, bj920000），
    # 去掉前2位前缀，统一为纯数字代码，与腾讯API返回格式一致
    codes = codes_raw.str[2:] if codes_raw.str[0].str.match(r'[a-z]').all() else codes_raw
    result = pd.DataFrame({
        "code": codes,
        "name": df[cols[1]].astype(str),
    })

    # 写入缓存
    result.to_json(cache_file, orient="records", force_ascii=False)
    return result


# ============================================================
# 行业分类缓存
# ============================================================

def _get_sector_map(codes: List[str]) -> Dict[str, str]:
    """批量获取股票行业分类，缓存到文件（行业变动极少，缓存24小时）.

    使用腾讯 stockinfo API，取 plate[0].name 作为所属行业。
    首次构建约需 2-3 分钟（5000+ 只股票，10 并发）。
    """
    cache_file = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               ".sector_cache.json")
    cache: Dict[str, str] = {}

    # 读取缓存
    if os.path.exists(cache_file):
        mtime = os.path.getmtime(cache_file)
        if time.time() - mtime < 604800:  # 7 天有效，行业分类极少变动
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    cache = json.load(f)
            except (json.JSONDecodeError, ValueError):
                pass

    # 找出缓存中没有的代码
    missing = [c for c in codes if c not in cache]
    if not missing:
        return cache

    def _fetch_one(code: str) -> Optional[tuple]:
        prefix = _code_to_tencent_prefix(code)
        try:
            r = requests.get(
                f'https://web.ifzq.gtimg.cn/appstock/app/stockinfo/jiankuang'
                f'?code={prefix}',
                timeout=10,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Referer': 'https://gu.qq.com/',
                },
            )
            if r.status_code == 200:
                data = json.loads(r.text)
                plates = data.get('data', {}).get('gsjj', {}).get('plate', [])
                if plates:
                    return (code, plates[0]['name'])
        except Exception:
            pass
        return None

    session = _create_session()
    max_workers = 10
    fetched = 0
    total = len(missing)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_fetch_one, c): c for c in missing}
        for future in as_completed(futures):
            try:
                result = future.result()
                if result:
                    cache[result[0]] = result[1]
            except Exception:
                pass
            fetched += 1
            if fetched % 500 == 0:
                pass  # 仅用于计数，静默

    # 未获取到的标记为空
    for c in missing:
        if c not in cache:
            cache[c] = ""

    # 写入缓存
    try:
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
    except OSError:
        pass

    return cache


# ============================================================
# 腾讯实时行情批量查询
# ============================================================

def _parse_tencent_line(line: str) -> Optional[dict]:
    """解析腾讯单只股票数据行.

    腾讯字段顺序（以 ~ 分隔，索引从0开始）：
      [1]=名称, [2]=代码, [3]=现价, [31]=涨跌额, [32]=涨跌幅,
      [38]=换手率, [44]=总市值(亿), [49]=量比
    """
    if '="' not in line:
        return None
    # 提取 = 后面的数据部分（去掉开头 v_xxx=" 和结尾 "）
    try:
        data_str = line.split('="', 1)[1].rstrip('";\n')
    except IndexError:
        return None

    fields = data_str.split('~')
    if len(fields) < 50:
        return None

    try:
        return {
            "code": fields[2],
            "name": fields[1],
            "price": float(fields[3]) if fields[3] else 0.0,
            "change_pct": float(fields[32]) if fields[32] else 0.0,
            "volume_ratio": float(fields[49]) if fields[49] else 0.0,
            "turnover_rate": float(fields[38]) if fields[38] else 0.0,
            "market_cap": float(fields[44]) if fields[44] else 0.0,
        }
    except (ValueError, IndexError):
        return None


def _code_to_tencent_prefix(code: str) -> str:
    """将纯数字代码转为腾讯接口的前缀格式.

    上海6开头 -> sh600519
    深圳0/3开头 -> sz000625
    北交所8/4/9开头 -> bj920000
    """
    if code.startswith('6'):
        return f'sh{code}'
    elif code.startswith(('0', '3')):
        return f'sz{code}'
    elif code.startswith(('8', '4', '9')):
        return f'bj{code}'
    return code


def fetch_tencent_data(codes: List[str]) -> Dict[str, dict]:
    """批量从腾讯获取实时行情，每批最多50只.

    Args:
        codes: 纯数字股票代码列表，如 ['600519', '000625']

    Returns:
        dict: code -> 股票数据字典
    """
    session = _create_session()
    result: Dict[str, dict] = {}
    batch_size = 50

    for i in range(0, len(codes), batch_size):
        batch = codes[i:i + batch_size]
        # 构建腾讯查询前缀：sh600519,sz000625
        q_parts = [_code_to_tencent_prefix(c) for c in batch]
        url = f"https://qt.gtimg.cn/q={','.join(q_parts)}"

        try:
            r = session.get(url, timeout=15)
            if r.status_code == 200:
                for line in r.text.strip().split('\n'):
                    if '="' in line:
                        stock = _parse_tencent_line(line)
                        if stock and stock.get("code"):
                            result[stock["code"]] = stock
        except Exception:
            continue

        # 温和限速，避免触发反爬
        time.sleep(0.05)

    return result


# ============================================================
# K 线数据获取（腾讯 K 线接口，供涨停和整理形态筛选共用）
# ============================================================

def _fetch_kline_data(code: str, lookback_days: int) -> Optional[List[dict]]:
    """获取单只股票近 N 个交易日的日K线数据.

    腾讯日K线（前复权）格式：["日期","开盘","收盘","最高","最低","成交量"]
    返回带涨跌幅的 dict 列表，按日期升序排列。

    Returns:
        [{date, open, close, high, low, volume, change_pct}, ...] 或 None
    """
    prefix = _code_to_tencent_prefix(code)
    limit = lookback_days + 15  # 多取几天覆盖非交易日

    try:
        r = requests.get(
            f'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
            f'?_var=kline_dayqfq&param={prefix},day,,,{limit},qfq',
            timeout=15,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://gu.qq.com/',
            },
        )
        if r.status_code != 200:
            return None

        text = r.text
        if text.startswith('kline_dayqfq='):
            text = text[len('kline_dayqfq='):]
        data = json.loads(text)
        raw = data.get('data', {}).get(prefix, {}).get('qfqday', [])
        if not raw:
            return None

        # 解析并计算涨跌幅
        klines: List[dict] = []
        prev_close = None
        for row in raw:
            if len(row) < 5:
                continue
            try:
                o = float(row[1])
                c = float(row[2])
                h = float(row[3])
                l = float(row[4])
                v = float(row[5]) if len(row) >= 6 else 0.0
            except (ValueError, TypeError):
                continue

            chg = 0.0
            if prev_close is not None and prev_close > 0:
                chg = (c - prev_close) / prev_close * 100

            klines.append({
                "date": row[0],
                "open": o,
                "close": c,
                "high": h,
                "low": l,
                "volume": v,
                "change_pct": round(chg, 2),
            })
            prev_close = c

        return klines

    except Exception:
        return None


def fetch_kline_batch(codes: List[str],
                      lookback_days: int = 20) -> Dict[str, List[dict]]:
    """批量获取 K 线数据，多线程并发.

    Returns:
        dict: code -> kline dict 列表
    """
    if not codes:
        return {}

    result: Dict[str, List[dict]] = {}
    max_workers = min(10, len(codes))

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(_fetch_kline_data, code, lookback_days): code
            for code in codes
        }
        for future in as_completed(futures):
            code = futures[future]
            try:
                klines = future.result()
                if klines:
                    result[code] = klines
            except Exception:
                pass

    return result


def _count_limit_ups(klines: List[dict], code: str) -> int:
    """从 K 线数据中统计涨停次数."""
    threshold = _get_limit_threshold(code)
    count = 0
    for k in klines:
        if k.get("change_pct", 0) >= threshold:
            count += 1
    return count


def _check_consolidation(klines: List[dict], code: str,
                         min_count: int, range_low_pct: float,
                         range_high_pct: float) -> bool:
    """检查涨停后整理形态.

    条件：
    1. 近 N 日至少有 min_count 次涨停
    2. 以最后一次涨停的最高价为基准
    3. 该涨停日之后的所有交易日，最高价和最低价都在
       [基准价 × (1 + range_low_pct%), 基准价 × (1 + range_high_pct%)] 范围内
    """
    threshold = _get_limit_threshold(code)

    # 找到所有涨停日的索引
    lu_indices = [i for i, k in enumerate(klines)
                  if k.get("change_pct", 0) >= threshold]

    if len(lu_indices) < min_count:
        return False

    last_lu_idx = lu_indices[-1]
    # 最后一天是涨停的不算，需要有至少一天整理确认
    if last_lu_idx == len(klines) - 1:
        return False
    last_lu_high = klines[last_lu_idx]["high"]

    range_low = last_lu_high * (1 + range_low_pct / 100.0)
    range_high = last_lu_high * (1 + range_high_pct / 100.0)

    # 检查涨停日之后的所有交易日
    for i in range(last_lu_idx + 1, len(klines)):
        k = klines[i]
        if k["low"] < range_low or k["high"] > range_high:
            return False

    return True


# ============================================================
# 板块资金流向
# ============================================================

def fetch_sector_flows() -> List[dict]:
    """获取板块资金流向排名，缓存5分钟.

    使用 push2delay.eastmoney.com 接口获取行业板块数据：
    - 板块名称、涨跌幅、主力净流入、净流入占比

    Returns:
        [{name, change_pct, main_inflow, inflow_ratio, hot}, ...]
    """
    cache_file = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               ".sector_flow_cache.json")

    if os.path.exists(cache_file):
        mtime = os.path.getmtime(cache_file)
        if time.time() - mtime < 300:  # 5 分钟有效
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, ValueError):
                pass

    try:
        r = requests.get(
            "https://push2delay.eastmoney.com/api/qt/clist/get",
            params={
                "pn": "1",
                "pz": "200",
                "po": "0",
                "np": "1",
                "ut": "b2884a393a59ad64002292a3e90d46a5",
                "fltt": "2",
                "invt": "2",
                "fid": "f62",
                "fs": "m:90 t:2",
                "fields": "f12,f14,f2,f3,f62,f184",
                "_": str(int(time.time() * 1000)),
            },
            timeout=15,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://data.eastmoney.com/",
            },
        )
        if r.status_code != 200:
            return []

        data = r.json()
        items = data.get("data", {}).get("diff", [])
        if not items:
            return []

        sectors: List[dict] = []
        for item in items:
            chg = float(item.get("f3", 0) or 0)
            inflow = float(item.get("f62", 0) or 0)  # 主力净流入（元）
            inflow_ratio = float(item.get("f184", 0) or 0)  # 主力净流入占比(%)
            sectors.append({
                "name": item.get("f14", ""),
                "change_pct": round(chg, 2),
                "main_inflow": round(inflow / 1e8, 2),  # 转为亿元
                "inflow_ratio": round(inflow_ratio, 2),
            })

        # 标记热门板块：净流入排名前 10，且涨幅 > 行业均值
        if sectors:
            avg_chg = sum(s["change_pct"] for s in sectors) / len(sectors)
            ranked = sorted(sectors, key=lambda x: x["main_inflow"], reverse=True)
            hot_names = {s["name"] for s in ranked[:10] if s["change_pct"] > avg_chg}
            for s in sectors:
                s["hot"] = s["name"] in hot_names

        # 保存每日快照到历史文件（用于10日趋势分析）
        _save_flow_snapshot(sectors)

        # 写入缓存
        try:
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(sectors, f, ensure_ascii=False)
        except OSError:
            pass

        return sectors

    except Exception:
        return []


def _load_flow_history() -> dict:
    """加载行业资金流向历史数据."""
    history_file = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".sector_flow_history.json")
    if os.path.exists(history_file):
        try:
            with open(history_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, ValueError):
            pass
    return {}


def _save_flow_snapshot(sectors: List[dict]):
    """保存当日行业资金快照到历史文件，每日仅保存一次，保留最近10天."""
    today = datetime.now().strftime("%Y-%m-%d")
    history = _load_flow_history()

    if today in history:
        return

    # 保留最近10天
    dates = sorted(history.keys())
    while len(dates) >= 10:
        oldest = dates.pop(0)
        del history[oldest]

    history[today] = sectors
    history_file = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                ".sector_flow_history.json")
    try:
        with open(history_file, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False)
    except OSError:
        pass


def analyze_hot_industries() -> List[dict]:
    """分析10日行业资金流向，计算热度分、趋势和持续性.

    冷启动降级：
    - 0 天历史 → 调用 fetch_sector_flows() 返回单日 top 10
    - 1-5 天 → 简单累计求和排序
    - 6+ 天 → 完整加权公式 + 趋势 + 持续性

    Returns:
        [{name, total_inflow_10d, inflow_days, avg_inflow_3d,
          heat_score, trend, change_pct}, ...] 按 heat_score 降序
    """
    history = _load_flow_history()

    if not history:
        sectors = fetch_sector_flows()
        # 单日降级：按净流入排序取前10
        ranked = sorted(sectors, key=lambda x: x.get("main_inflow", 0), reverse=True)
        return [
            {
                "name": s["name"],
                "total_inflow_10d": s.get("main_inflow", 0),
                "inflow_days": 1 if s.get("main_inflow", 0) > 0 else 0,
                "avg_inflow_3d": s.get("main_inflow", 0),
                "heat_score": round(s.get("main_inflow", 0), 1),
                "trend": "stable",
                "change_pct": s.get("change_pct", 0),
            }
            for s in ranked[:10]
        ]

    dates = sorted(history.keys())[-10:]
    days_count = len(dates)

    # 构建行业时间序列
    industry_data: Dict[str, dict] = {}
    for date in dates:
        day_sectors = history[date]
        for s in day_sectors:
            name = s["name"]
            if name not in industry_data:
                industry_data[name] = {"inflows": [], "changes": []}
            industry_data[name]["inflows"].append(s.get("main_inflow", 0))
            industry_data[name]["changes"].append(s.get("change_pct", 0))

    results = []
    for name, ts in industry_data.items():
        inflows = ts["inflows"]
        if len(inflows) < max(days_count - 2, 1):
            continue

        total_10d = sum(inflows)
        inflow_days = sum(1 for v in inflows if v > 0)

        if days_count < 6:
            # 简单累计求和，不加权
            heat = total_10d
            trend = "stable"
            avg_3d = sum(inflows[-3:]) / min(3, len(inflows)) if inflows else 0
        else:
            # 加权公式
            recent_3 = inflows[-3:] if len(inflows) >= 3 else inflows
            mid_4_7 = inflows[-7:-3] if len(inflows) >= 7 else []
            old_8_10 = inflows[-10:-7] if len(inflows) >= 10 else []

            avg_3d = sum(recent_3) / len(recent_3) if recent_3 else 0
            avg_mid = sum(mid_4_7) / len(mid_4_7) if mid_4_7 else 0
            avg_old = sum(old_8_10) / len(old_8_10) if old_8_10 else 0

            heat = avg_3d * 0.5 + avg_mid * 0.3 + avg_old * 0.2
            if inflow_days >= 7:
                heat += 10
            elif inflow_days >= 5:
                heat += 5

            # 趋势：后半段 vs 前半段
            half = len(inflows) // 2
            first_half_avg = sum(inflows[:half]) / half if half > 0 else 0
            second_half_avg = sum(inflows[half:]) / (len(inflows) - half) if len(inflows) > half else 0
            if second_half_avg > first_half_avg * 1.2:
                trend = "up"
            elif second_half_avg < first_half_avg * 0.8:
                trend = "down"
            else:
                trend = "stable"

        change_pct = ts["changes"][-1] if ts["changes"] else 0

        results.append({
            "name": name,
            "total_inflow_10d": round(total_10d, 2),
            "inflow_days": inflow_days,
            "avg_inflow_3d": round(avg_3d, 2),
            "heat_score": round(heat, 1),
            "trend": trend,
            "change_pct": round(change_pct, 2),
        })

    results.sort(key=lambda x: x["heat_score"], reverse=True)
    return results


# ============================================================
# 筛选逻辑
# ============================================================

def _build_pre_mask(df: pd.DataFrame, req: ScreenRequest) -> pd.Series:
    """构建预筛选掩码（不含涨停条件），用于缩小涨停历史查询范围."""
    mask = pd.Series(True, index=df.index)

    if req.change_pct.enabled:
        lo = req.change_pct.min_val if req.change_pct.min_val is not None else -100.0
        hi = req.change_pct.max_val if req.change_pct.max_val is not None else 100.0
        mask &= (df["change_pct"] >= lo) & (df["change_pct"] <= hi)

    if req.volume_ratio.enabled:
        lo = req.volume_ratio.min_val if req.volume_ratio.min_val is not None else 0.0
        mask &= (df["volume_ratio"] >= lo)

    if req.turnover_rate.enabled:
        lo = req.turnover_rate.min_val if req.turnover_rate.min_val is not None else 0.0
        hi = req.turnover_rate.max_val if req.turnover_rate.max_val is not None else 100.0
        mask &= (df["turnover_rate"] >= lo) & (df["turnover_rate"] <= hi)

    if req.market_cap.enabled:
        lo = req.market_cap.min_val if req.market_cap.min_val is not None else 0.0
        hi = req.market_cap.max_val if req.market_cap.max_val is not None else float("inf")
        mask &= (df["market_cap"] >= lo) & (df["market_cap"] <= hi)

    return mask


def apply_filters(df: pd.DataFrame,
                  req: ScreenRequest,
                  limit_up_counts: Dict[str, int],
                  consolidation_pass: Optional[Dict[str, bool]] = None) -> List[StockInfo]:
    """应用完整筛选条件，返回 StockInfo 列表."""
    mask = _build_pre_mask(df, req)
    filtered = df[mask]

    # 涨停次数条件
    if req.limit_up.enabled:
        min_count = req.limit_up.extra.get("min_count", 1)
        filtered = filtered[
            filtered["code"].map(lambda c: limit_up_counts.get(c, 0) >= min_count)
        ]

    # 涨停后整理条件
    if req.limit_up_consolidation.enabled and consolidation_pass is not None:
        filtered = filtered[
            filtered["code"].map(lambda c: consolidation_pass.get(c, False))
        ]

    results: List[StockInfo] = []
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


# ============================================================
# 主筛选入口
# ============================================================

def run_screen(req: ScreenRequest) -> dict:
    """执行一次完整筛选，返回结果字典."""
    start_time = time.time()

    # 1. 获取股票列表（带缓存）
    stock_list = get_stock_list()
    codes = stock_list["code"].tolist()
    total = len(codes)

    # 2. 获取腾讯实时行情
    tencent_data = fetch_tencent_data(codes)

    # 3. 获取行业分类映射（带缓存）
    sector_map = _get_sector_map(codes)

    # 4. 构建 DataFrame
    rows: List[dict] = []
    for code in codes:
        if code not in tencent_data:
            continue
        t = tencent_data[code]
        # 优先使用缓存中的股票名称
        name_rows = stock_list[stock_list["code"] == code]
        name = str(name_rows.iloc[0]["name"]) if len(name_rows) > 0 else ""
        rows.append({
            "code": code,
            "name": name if name else t.get("name", ""),
            "price": t["price"],
            "change_pct": t["change_pct"],
            "volume_ratio": t["volume_ratio"],
            "turnover_rate": t["turnover_rate"],
            "market_cap": t["market_cap"],
            "sector": sector_map.get(code, ""),
        })

    df = pd.DataFrame(rows)

    if df.empty:
        return {
            "total_scanned": total,
            "matched": 0,
            "updated_at": datetime.now().strftime("%H:%M:%S"),
            "stocks": [],
        }

    # 5. K 线数据获取（涨停次数 + 整理形态 共用）
    #    先预筛选，只对符合条件的股票查询 K 线
    limit_up_counts: Dict[str, int] = {}
    consolidation_pass: Dict[str, bool] = {}
    need_kline = req.limit_up.enabled or req.limit_up_consolidation.enabled

    if need_kline:
        pre_mask = _build_pre_mask(df, req)
        pre_codes = df[pre_mask]["code"].tolist()

        # 取两个条件中较大的回溯天数
        lookback = 20
        if req.limit_up.enabled:
            lookback = max(lookback, int(req.limit_up.extra.get("days", 20)))
        if req.limit_up_consolidation.enabled:
            lookback = max(lookback, int(req.limit_up_consolidation.extra.get("days", 20)))

        kline_data = fetch_kline_batch(pre_codes, lookback)

        # 从同一份 K 线数据计算涨停次数
        if req.limit_up.enabled:
            for code, klines in kline_data.items():
                limit_up_counts[code] = _count_limit_ups(klines, code)

        # 检查整理形态
        if req.limit_up_consolidation.enabled:
            ex = req.limit_up_consolidation.extra
            min_count = int(ex.get("min_count", 2))
            range_low = float(ex.get("range_low", -10))
            range_high = float(ex.get("range_high", 5))
            for code, klines in kline_data.items():
                consolidation_pass[code] = _check_consolidation(
                    klines, code, min_count, range_low, range_high
                )

    # 6. 应用完整筛选
    stocks = apply_filters(df, req, limit_up_counts, consolidation_pass if consolidation_pass else None)

    elapsed = time.time() - start_time

    return {
        "total_scanned": total,
        "matched": len(stocks),
        "updated_at": datetime.now().strftime("%H:%M:%S"),
        "elapsed_seconds": round(elapsed, 1),
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
