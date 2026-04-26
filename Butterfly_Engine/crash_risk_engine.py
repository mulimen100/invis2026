import datetime
import json
import os
from contextlib import closing
from typing import Dict, Tuple

import numpy as np
import pandas as pd
import yfinance as yf


class CrashRiskEngine:
    """
    Daily crash-risk overlay engine (separate from main regime).
    Output: score 0-100 + flag (GREEN/YELLOW/ORANGE/RED/BLACK) + factors.
    """

    def __init__(self):
        self.base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.global_dir = os.path.join(self.base_dir, "data_snapshot", "global")
        self._load_env_file()

    def _load_env_file(self):
        env_path = os.path.join(self.base_dir, ".env")
        if not os.path.exists(env_path):
            return
        try:
            with open(env_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    if k and (k not in os.environ):
                        os.environ[k] = v
        except Exception:
            pass

    def _load_csv(self, ticker: str) -> pd.DataFrame | None:
        path = os.path.join(self.global_dir, f"{ticker.lower()}.csv")
        if not os.path.exists(path):
            return None
        try:
            df = pd.read_csv(path)
            if "date" not in df.columns or "close" not in df.columns:
                return None
            df["date"] = pd.to_datetime(df["date"], errors="coerce")
            df = df.dropna(subset=["date"]).sort_values("date")
            return df
        except Exception:
            return None

    @staticmethod
    def _norm(value: float, lo: float, hi: float) -> float:
        if hi <= lo:
            return 50.0
        x = (value - lo) / (hi - lo)
        return float(max(0.0, min(100.0, x * 100.0)))

    @staticmethod
    def _flag(score: float) -> str:
        if score >= 86:
            return "BLACK"
        if score >= 70:
            return "RED"
        if score >= 46:
            return "ORANGE"
        if score >= 26:
            return "YELLOW"
        return "GREEN"

    def _spy_tech(self) -> Tuple[float, float, float]:
        spy = self._load_csv("spy")
        if spy is None or len(spy) < 60:
            return 50.0, 0.0, 0.0
        close = spy["close"].astype(float)
        ma20 = close.rolling(20).mean().iloc[-1]
        ma50 = close.rolling(50).mean().iloc[-1]
        px = float(close.iloc[-1])
        below20 = 1.0 if px < ma20 else 0.0
        below50 = 1.0 if px < ma50 else 0.0
        tech_score = 60.0 + 20.0 * below20 + 20.0 * below50
        return float(min(100.0, tech_score)), float(ma20), float(ma50)

    def _vix_score(self) -> Tuple[float, float]:
        vix = self._load_csv("vix")
        if vix is None or len(vix) < 2:
            # fallback live
            try:
                hist = yf.Ticker("^VIX").history(period="7d")
                if hist.empty:
                    return 50.0, 20.0
                val = float(hist["Close"].iloc[-1])
            except Exception:
                val = 20.0
        else:
            val = float(vix["close"].iloc[-1])

        if val < 16:
            score = 20.0
        elif val < 20:
            score = 35.0
        elif val < 25:
            score = 55.0
        elif val < 30:
            score = 72.0
        else:
            score = 90.0
        return float(score), float(val)

    def _credit_score(self) -> Tuple[float, float]:
        # Proxy for HY stress: HYG / IEF ratio (falling ratio => widening stress).
        try:
            h = yf.Ticker("HYG").history(period="6mo")
            i = yf.Ticker("IEF").history(period="6mo")
            if h.empty or i.empty:
                return 50.0, 0.0
            idx = h.index.intersection(i.index)
            ratio = (h.loc[idx, "Close"] / i.loc[idx, "Close"]).dropna()
            if len(ratio) < 30:
                return 50.0, 0.0
            ma20 = ratio.rolling(20).mean()
            spread_up = float((ma20.iloc[-2] - ma20.iloc[-1]) / max(1e-9, ma20.iloc[-2]) * 100.0)
            # More sensitive calibration: +0.6% deterioration already meaningful for stress.
            score = self._norm(spread_up, 0.0, 0.6)
            return float(score), float(spread_up)
        except Exception:
            return 50.0, 0.0

    def _liquidity_score(self) -> Tuple[float, float]:
        """
        Proxy for liquidity regime using Fed balance fallback:
        - If FRED key exists: WRESBAL 4-week change
        - Else: broad market liquidity proxy via SPY dollar volume trend
        """
        fred_key = os.environ.get("FRED_API_KEY", "").strip()
        if fred_key:
            try:
                import requests

                url = "https://api.stlouisfed.org/fred/series/observations"
                params = {
                    "series_id": "WRESBAL",
                    "api_key": fred_key,
                    "file_type": "json",
                    "sort_order": "desc",
                    "limit": 16,
                }
                r = requests.get(url, params=params, timeout=15)
                obs = (r.json() or {}).get("observations", [])
                vals = [float(x.get("value")) for x in obs if x.get("value") not in {".", None, ""}]
                if len(vals) >= 5:
                    # Desc order: vals[0] latest, vals[4] ~4 weeks ago
                    chg = (vals[0] - vals[4]) / max(1e-9, vals[4]) * 100.0
                    # Falling balance sheet => higher risk
                    score = self._norm(-chg, 0.0, 2.0)
                    return float(score), float(chg)
            except Exception:
                pass

        spy = self._load_csv("spy")
        if spy is None or len(spy) < 25 or "volume" not in spy.columns:
            return 50.0, 0.0
        vol = pd.to_numeric(spy["volume"], errors="coerce").fillna(0.0)
        close = pd.to_numeric(spy["close"], errors="coerce").fillna(0.0)
        dollar = (vol * close).replace([np.inf, -np.inf], np.nan).dropna()
        if len(dollar) < 25:
            return 50.0, 0.0
        ma5 = float(dollar.tail(5).mean())
        ma20 = float(dollar.tail(20).mean())
        chg = (ma5 - ma20) / max(1e-9, ma20) * 100.0
        # Falling recent liquidity => higher risk
        score = self._norm(-chg, 0.0, 25.0)
        return float(score), float(chg)

    def _breadth_score(self) -> Tuple[float, float]:
        # Breadth proxy from local universe CSVs: % above SMA50
        try:
            files = [f for f in os.listdir(self.global_dir) if f.endswith(".csv")]
        except Exception:
            return 50.0, 50.0
        above = 0
        total = 0
        for fname in files[:220]:
            path = os.path.join(self.global_dir, fname)
            try:
                df = pd.read_csv(path)
                if "close" not in df.columns or len(df) < 55:
                    continue
                c = pd.to_numeric(df["close"], errors="coerce").dropna()
                if len(c) < 55:
                    continue
                sma50 = float(c.tail(50).mean())
                px = float(c.iloc[-1])
                total += 1
                if px > sma50:
                    above += 1
            except Exception:
                continue
        if total < 25:
            return 50.0, 50.0
        pct = (above / total) * 100.0
        # Lower breadth => higher risk (more sensitive around 40-60% zone).
        score = self._norm(65.0 - pct, 0.0, 30.0)
        return float(score), float(pct)

    def _curve_score(self) -> Tuple[float, float]:
        # 10Y-2Y proxy; fallback to ^TNX - ^IRX
        try:
            tnx = yf.Ticker("^TNX").history(period="1mo")
            irx = yf.Ticker("^IRX").history(period="1mo")
            if tnx.empty or irx.empty:
                return 50.0, 0.0
            idx = tnx.index.intersection(irx.index)
            if len(idx) < 5:
                return 50.0, 0.0
            spread = float(tnx.loc[idx, "Close"].iloc[-1] - irx.loc[idx, "Close"].iloc[-1])
            # Deep inversion => higher risk
            score = self._norm(-spread, 0.0, 1.0)
            return float(score), float(spread)
        except Exception:
            return 50.0, 0.0

    def analyze(self) -> Dict:
        credit_score, credit_delta = self._credit_score()
        liq_score, liq_delta = self._liquidity_score()
        breadth_score, breadth_pct = self._breadth_score()
        vix_score, vix_val = self._vix_score()
        tech_score, ma20, ma50 = self._spy_tech()
        curve_score, curve_spread = self._curve_score()

        # Gating: activate high-risk mode only when credit stress + (liquidity weakness or breadth weak)
        credit_stress = credit_score >= 45.0
        liquidity_weak = liq_score >= 50.0
        breadth_weak = breadth_pct < 50.0
        vix_stress = vix_score >= 72.0
        tech_stress = tech_score >= 70.0
        gated = bool(
            (credit_stress and (liquidity_weak or breadth_weak))
            or (vix_stress and tech_stress)
        )

        weighted = (
            0.35 * credit_score
            + 0.25 * liq_score
            + 0.20 * breadth_score
            + 0.10 * vix_score
            + 0.10 * tech_score
        )
        # If gating not active, cap near ORANGE entrance (still prevents panic flags).
        final_score = float(min(weighted, 55.0) if not gated else weighted)
        # Add curve as secondary kicker (small additive, bounded)
        final_score = float(max(0.0, min(100.0, final_score + 0.05 * curve_score)))

        flag = self._flag(final_score)
        two_of_three = sum([
            1 if credit_stress else 0,
            1 if breadth_weak else 0,
            1 if tech_score >= 60.0 else 0,
        ]) >= 2

        summary = (
            f"{flag} {final_score:.1f} | credit={credit_score:.1f} "
            f"liq={liq_score:.1f} breadth={breadth_pct:.1f}% vix={vix_val:.1f}"
        )

        return {
            "score": round(final_score, 2),
            "flag": flag,
            "gated": gated,
            "two_of_three_confirmed": bool(two_of_three),
            "summary": summary,
            "factors": {
                "credit_score": round(credit_score, 2),
                "credit_delta_pct": round(credit_delta, 3),
                "liquidity_score": round(liq_score, 2),
                "liquidity_delta_pct": round(liq_delta, 3),
                "breadth_score": round(breadth_score, 2),
                "breadth_pct_above_ma50": round(breadth_pct, 2),
                "vix_score": round(vix_score, 2),
                "vix_value": round(vix_val, 2),
                "technical_score": round(tech_score, 2),
                "spy_ma20": round(ma20, 4),
                "spy_ma50": round(ma50, 4),
                "curve_score": round(curve_score, 2),
                "curve_spread_proxy": round(curve_spread, 4),
            },
            "updated_at": datetime.datetime.utcnow().isoformat(),
        }

    def save_status(self, data: Dict):
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            print("⚠️ DATABASE_URL missing; crash risk status not persisted.")
            return
        try:
            import psycopg2

            with closing(psycopg2.connect(db_url)) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS crash_risk_status (
                            id INTEGER PRIMARY KEY DEFAULT 1,
                            score DOUBLE PRECISION,
                            flag TEXT,
                            gated BOOLEAN,
                            two_of_three_confirmed BOOLEAN,
                            summary TEXT,
                            raw_json JSONB,
                            updated_at TIMESTAMP DEFAULT NOW()
                        );
                        """
                    )
                    cur.execute(
                        """
                        INSERT INTO crash_risk_status
                            (id, score, flag, gated, two_of_three_confirmed, summary, raw_json, updated_at)
                        VALUES
                            (1, %s, %s, %s, %s, %s, %s::jsonb, NOW())
                        ON CONFLICT (id) DO UPDATE SET
                            score = EXCLUDED.score,
                            flag = EXCLUDED.flag,
                            gated = EXCLUDED.gated,
                            two_of_three_confirmed = EXCLUDED.two_of_three_confirmed,
                            summary = EXCLUDED.summary,
                            raw_json = EXCLUDED.raw_json,
                            updated_at = NOW();
                        """,
                        (
                            float(data.get("score", 0.0)),
                            str(data.get("flag", "GREEN")),
                            bool(data.get("gated", False)),
                            bool(data.get("two_of_three_confirmed", False)),
                            str(data.get("summary", "")),
                            json.dumps(data),
                        ),
                    )
                    conn.commit()
            print("[SUCCESS] Saved to DB Table: crash_risk_status")
        except Exception as e:
            print(f"❌ Failed to save crash risk status: {e}")


if __name__ == "__main__":
    engine = CrashRiskEngine()
    out = engine.analyze()
    engine.save_status(out)
    print(out)
