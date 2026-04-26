import os
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf


def _norm(x: pd.Series, lo: float, hi: float) -> pd.Series:
    if hi <= lo:
        return pd.Series(50.0, index=x.index)
    out = ((x - lo) / (hi - lo)) * 100.0
    return out.clip(0.0, 100.0)


def _flag(v: float) -> str:
    if v >= 86:
        return "BLACK"
    if v >= 70:
        return "RED"
    if v >= 46:
        return "ORANGE"
    if v >= 26:
        return "YELLOW"
    return "GREEN"


def build_backtest_frame(period: str = "10y") -> pd.DataFrame:
    # Core market data
    spy = yf.Ticker("SPY").history(period=period)[["Close", "Volume"]].rename(columns={"Close": "spy"})
    vix = yf.Ticker("^VIX").history(period=period)[["Close"]].rename(columns={"Close": "vix"})
    hyg = yf.Ticker("HYG").history(period=period)[["Close"]].rename(columns={"Close": "hyg"})
    ief = yf.Ticker("IEF").history(period=period)[["Close"]].rename(columns={"Close": "ief"})
    tnx = yf.Ticker("^TNX").history(period=period)[["Close"]].rename(columns={"Close": "tnx"})
    irx = yf.Ticker("^IRX").history(period=period)[["Close"]].rename(columns={"Close": "irx"})
    rsp = yf.Ticker("RSP").history(period=period)[["Close"]].rename(columns={"Close": "rsp"})

    df = spy.join([vix, hyg, ief, tnx, irx, rsp], how="outer").sort_index()
    # Align mixed calendars and sparse macro fields
    for c in ["spy", "Volume", "vix", "hyg", "ief", "tnx", "irx", "rsp"]:
        if c in df.columns:
            df[c] = df[c].ffill()
    df = df.dropna(subset=["spy", "Volume", "vix", "hyg", "ief", "tnx", "irx", "rsp"])
    if len(df) < 220:
        raise RuntimeError(f"Insufficient joined history for crash backtest (rows={len(df)}).")

    # Factors
    ratio = (df["hyg"] / df["ief"]).rename("credit_ratio")
    credit_delta = ((ratio.rolling(20).mean().shift(1) - ratio.rolling(20).mean()) / ratio.rolling(20).mean().shift(1)) * 100.0
    credit_score = _norm(credit_delta.fillna(0.0), 0.0, 0.6)

    dollar = (df["spy"] * df["Volume"]).replace([np.inf, -np.inf], np.nan).ffill()
    liq_delta = ((dollar.rolling(5).mean() - dollar.rolling(20).mean()) / dollar.rolling(20).mean()) * 100.0
    liq_score = _norm((-liq_delta).fillna(0.0), 0.0, 25.0)

    breadth_proxy = (df["rsp"] / df["spy"]).replace([np.inf, -np.inf], np.nan)
    breadth_pct_proxy = ((breadth_proxy / breadth_proxy.rolling(50).mean()) * 50.0).clip(0.0, 100.0)
    breadth_score = _norm((65.0 - breadth_pct_proxy).fillna(0.0), 0.0, 30.0)

    vix_score = pd.Series(35.0, index=df.index)
    vix_score[df["vix"] < 16] = 20.0
    vix_score[(df["vix"] >= 20) & (df["vix"] < 25)] = 55.0
    vix_score[(df["vix"] >= 25) & (df["vix"] < 30)] = 72.0
    vix_score[df["vix"] >= 30] = 90.0

    ma20 = df["spy"].rolling(20).mean()
    ma50 = df["spy"].rolling(50).mean()
    tech_score = pd.Series(60.0, index=df.index)
    tech_score += (df["spy"] < ma20).astype(float) * 20.0
    tech_score += (df["spy"] < ma50).astype(float) * 20.0
    tech_score = tech_score.clip(0.0, 100.0)

    curve = (df["tnx"] - df["irx"]).fillna(0.0)
    curve_score = _norm((-curve), 0.0, 1.0)

    credit_stress = credit_score >= 45.0
    liq_weak = liq_score >= 50.0
    breadth_weak = breadth_pct_proxy < 50.0
    vix_stress = vix_score >= 72.0
    tech_stress = tech_score >= 70.0
    gated = (credit_stress & (liq_weak | breadth_weak)) | (vix_stress & tech_stress)
    two_of_three = (
        credit_stress.astype(int)
        + breadth_weak.astype(int)
        + (tech_score >= 60.0).astype(int)
    ) >= 2

    score = (
        0.35 * credit_score
        + 0.25 * liq_score
        + 0.20 * breadth_score
        + 0.10 * vix_score
        + 0.10 * tech_score
    )
    score = pd.Series(np.where(gated, score, np.minimum(score, 55.0)), index=df.index)
    score = (score + (0.05 * curve_score)).clip(0.0, 100.0)

    out = pd.DataFrame(
        {
            "spy": df["spy"],
            "score": score,
            "credit_score": credit_score,
            "liquidity_score": liq_score,
            "breadth_score": breadth_score,
            "breadth_proxy_pct": breadth_pct_proxy,
            "vix": df["vix"],
            "vix_score": vix_score,
            "tech_score": tech_score,
            "curve_spread": curve,
            "curve_score": curve_score,
            "gated": gated.astype(int),
            "two_of_three": two_of_three.astype(int),
        }
    ).dropna()

    out["flag"] = out["score"].apply(_flag)
    severe_prev = out["flag"].isin(["RED", "BLACK"]).shift(1)
    severe_prev = severe_prev.where(severe_prev.notna(), False).astype(bool)
    # Calibrated alert event:
    # - BLACK immediate if gated
    # - RED requires persistence + gating + confirmation
    out["alert_event"] = (
        ((out["flag"] == "BLACK") & (out["gated"] == 1))
        | (
            (out["flag"] == "RED")
            & severe_prev
            & (out["gated"] == 1)
            & (out["two_of_three"] == 1)
        )
    ).astype(int)

    # Forward risk labels
    fwd5 = (out["spy"].shift(-5) / out["spy"] - 1.0) * 100.0
    fwd20 = (out["spy"].shift(-20) / out["spy"] - 1.0) * 100.0
    out["fwd5_pct"] = fwd5
    out["fwd20_pct"] = fwd20
    out["event_5d_drop_gt3"] = (fwd5 <= -3.0).astype(int)
    out["event_20d_drop_gt7"] = (fwd20 <= -7.0).astype(int)
    return out.dropna()


def summarize(df: pd.DataFrame) -> dict:
    severe = df[df["alert_event"] == 1].copy()
    all_n = len(df)
    sev_n = len(severe)

    hit5 = float(severe["event_5d_drop_gt3"].mean() * 100.0) if sev_n else 0.0
    hit20 = float(severe["event_20d_drop_gt7"].mean() * 100.0) if sev_n else 0.0
    false5 = float(100.0 - hit5) if sev_n else 0.0
    false20 = float(100.0 - hit20) if sev_n else 0.0

    # Lead-time proxy: count days from first RED/BLACK in each run until worst 20d drop point
    avg_lead = np.nan
    if sev_n:
        s = severe.reset_index()
        if "Date" in s.columns:
            s = s.rename(columns={"Date": "date"})
        elif "index" in s.columns:
            s = s.rename(columns={"index": "date"})
        runs = []
        start = None
        last_i = -2
        for i in s.index:
            if i != last_i + 1:
                if start is not None:
                    runs.append((start, last_i))
                start = i
            last_i = i
        if start is not None:
            runs.append((start, last_i))
        leads = []
        for a, b in runs:
            run = s.loc[a:b]
            worst_i = run["fwd20_pct"].idxmin()
            lead = int(max(0, worst_i - a))
            leads.append(lead)
        if leads:
            avg_lead = float(np.mean(leads))

    return {
        "rows": all_n,
        "alerts_red_black": sev_n,
        "days_red_black_any": int(df["flag"].isin(["RED", "BLACK"]).sum()),
        "hit_rate_5d_drop_gt3_pct": round(hit5, 2),
        "hit_rate_20d_drop_gt7_pct": round(hit20, 2),
        "false_alarm_5d_pct": round(false5, 2),
        "false_alarm_20d_pct": round(false20, 2),
        "avg_lead_days_proxy": None if np.isnan(avg_lead) else round(float(avg_lead), 2),
    }


def main():
    df = build_backtest_frame(period="10y")
    summary = summarize(df)

    out_dir = Path(__file__).resolve().parent / "data" / "crash_risk"
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

    rows_path = out_dir / "backtest_rows_latest.csv"
    rep_path = out_dir / "backtest_report_latest.md"
    hist_path = out_dir / f"backtest_rows_{ts}.csv"

    df.to_csv(rows_path, index=True)
    df.to_csv(hist_path, index=True)

    report = [
        "# Crash Risk Backtest (Latest)",
        "",
        f"- Generated UTC: `{datetime.utcnow().isoformat()}`",
        f"- Rows analyzed: **{summary['rows']}**",
        f"- RED/BLACK days (raw): **{summary['days_red_black_any']}**",
        f"- RED/BLACK alerts (after persistence/gating): **{summary['alerts_red_black']}**",
        f"- Hit rate (5d drop <= -3%): **{summary['hit_rate_5d_drop_gt3_pct']}%**",
        f"- Hit rate (20d drop <= -7%): **{summary['hit_rate_20d_drop_gt7_pct']}%**",
        f"- False alarm (5d): **{summary['false_alarm_5d_pct']}%**",
        f"- False alarm (20d): **{summary['false_alarm_20d_pct']}%**",
        f"- Avg lead-days proxy: **{summary['avg_lead_days_proxy']}**",
        "",
        "## Notes",
        "- This is a first-pass proxy backtest for calibration, not a final production benchmark.",
        "- Breadth uses RSP/SPY proxy due to historical constituent availability constraints.",
    ]
    rep_path.write_text("\n".join(report), encoding="utf-8")

    print("[OK] Crash risk backtest completed.")
    print(f" - rows: {rows_path}")
    print(f" - report: {rep_path}")
    print(f" - summary: {summary}")


if __name__ == "__main__":
    main()

