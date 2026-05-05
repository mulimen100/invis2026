import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const dynamic = 'force-dynamic'; // Always fresh — no caching

export async function GET() {
    try {
        // ─── 1. OPEN POSITIONS (Live Portfolio) ──────────────────────────
        const openResult = await sql`
            SELECT id, ticker, entry_price, peak_price, quantity, status, entry_date
            FROM positions
            WHERE status = 'OPEN'
            ORDER BY entry_date DESC
        `;

        // ─── 2. CLOSED POSITIONS — Since engine go-live (2026-04-09) ──────
        // Older records are test/sim data. GHOST/RECONCILER exits = orders never filled.
        // STATS_RESET tag = positions wiped by reset_stats.py — must be ignored even
        //   if entry_date is recent. The reset script tags closed positions with this
        //   sentinel so future stat calls skip them.
        // current_price for CLOSED rows = actual IBKR fill price (set by exit_engine
        //   when it confirms the fill). This is far more accurate than estimating
        //   from peak_price ± a hard-coded slippage assumption.
        //
        // VERIFIED override (added 2026-05-05): when the reconciler / close_position
        // ghost path manages to recover the real fill price via reqExecutions, the
        // reason is tagged IBKR_EXECUTED_CLOSE_VERIFIED. Those rows are real trades
        // with confirmed numbers — the audit trail in the reason text often still
        // mentions "reconciler" or "ghost" for traceability, so we explicitly let
        // VERIFIED rows through ahead of the substring filters below. Without this,
        // a real loss like TSLA #197 silently disappeared from the dashboard.
        const closedResult = await sql`
            SELECT ticker, entry_price, peak_price, current_price, quantity,
                   exit_reason, entry_date, exit_date
            FROM positions
            WHERE status = 'CLOSED'
              AND entry_price > 0
              AND entry_date >= '2026-04-09'
              AND (
                exit_reason ILIKE '%IBKR_EXECUTED_CLOSE_VERIFIED%'
                OR (
                    exit_reason NOT ILIKE '%GHOST%'
                    AND exit_reason NOT ILIKE '%ADVISORY%'
                    AND exit_reason NOT ILIKE '%RECONCILER%'
                    AND exit_reason NOT ILIKE '%STATS_RESET%'
                )
              )
            ORDER BY exit_date DESC
        `;

        // ─── 3. GOLD SIGNALS — Last 24h ──────────────────────────────────
        const goldResult = await sql`
            SELECT COUNT(*) AS count
            FROM risk_signals
            WHERE validation_status = 'GOLD'
              AND timestamp > NOW() - INTERVAL '24 hours'
        `;

        // ─── Win Rate + Cumulative Return ──────────────────────────────────
        // Source of truth for the realised exit price = current_price column.
        // exit_engine writes the confirmed IBKR fill price into current_price
        // at the moment it closes the row (status='CLOSED'). This captures real
        // slippage — including the wide gap that opens up in extended hours.
        //
        // Fallback chain when current_price is missing/zero (older rows from
        // before this convention): estimate from peak with a per-reason factor.
        //
        // W/L is decided by the REALISED return sign, not by the exit-reason
        // category — so a DPT that closed below entry is correctly a loss.
        let wins = 0;
        let losses = 0;
        let totalReturnPct = 0;

        for (const pos of closedResult.rows) {
            const reason = (pos.exit_reason || '').toUpperCase();
            const ep = parseFloat(pos.entry_price) || 0;
            const pp = parseFloat(pos.peak_price)  || ep;
            const cp = parseFloat(pos.current_price) || 0;
            if (ep <= 0) continue;

            const isHardLoss =
                reason.includes('STOP_LOSS') ||
                reason.includes('EMERGENCY') ||
                reason.includes('HARD_STOP');
            const isTrailing  = reason.includes('TRAILING_STOP');
            const isDpt       = reason.includes('DYNAMIC_TAKE_PROFIT');
            const isTakeProfit = reason.includes('TAKE_PROFIT') && !isDpt;
            const isRotation  = reason.includes('ROTATION');
            // IBKR_EXECUTED_CLOSE_VERIFIED: closed by reconciler, but the engine
            // confirmed the actual SELL fill price via reqExecutions. Numbers
            // are real, so it counts toward W/L just like a normal DPT/Stop.
            // The unverified variant (plain IBKR_EXECUTED_CLOSE) is still
            // skipped further up via the SQL NOT ILIKE filters.
            const isIbkrVerified = reason.includes('IBKR_EXECUTED_CLOSE_VERIFIED');
            const isRecognised = isHardLoss || isTrailing || isDpt
                              || isTakeProfit || isRotation || isIbkrVerified;
            if (!isRecognised) continue;

            // Prefer the actual IBKR fill price stored in current_price.
            // Fall back to peak-based estimates only for legacy rows.
            let exitPrice: number;
            if (cp > 0) {
                exitPrice = cp;
            } else if (isTrailing) {
                exitPrice = pp * 0.97;
            } else if (isDpt) {
                exitPrice = pp * 0.995;
            } else if (isHardLoss) {
                exitPrice = ep * 0.98; // legacy -2% assumption
            } else {
                exitPrice = pp;
            }

            const retPct = ((exitPrice - ep) / ep) * 100;
            totalReturnPct += retPct;
            if (retPct >= 0) wins++; else losses++;
        }

        const totalTrades = wins + losses;
        const winRate = totalTrades > 0
            ? Math.round((wins / totalTrades) * 1000) / 10
            : 0;
        const avgReturn = totalTrades > 0
            ? Math.round((totalReturnPct / totalTrades) * 100) / 100
            : 0;
        const cumulReturnPct = Math.round(totalReturnPct * 100) / 100;

        // ─── Build live positions list ────────────────────────────────────
        const openPositions = openResult.rows.map(pos => {
            const ep = parseFloat(pos.entry_price) || 0;
            const pp = parseFloat(pos.peak_price) || ep;
            const qty = parseInt(pos.quantity) || 0;
            const marketValue = pp * qty;
            const unrealizedPct = ep > 0
                ? Math.round(((pp - ep) / ep) * 10000) / 100
                : 0;

            return {
                id: pos.id,
                ticker: pos.ticker,
                entry_price: ep,
                peak_price: pp,
                quantity: qty,
                market_value: Math.round(marketValue),
                unrealized_pct: unrealizedPct,
                entry_date: pos.entry_date,
            };
        });

        return NextResponse.json({
            gold_win_rate:       winRate,
            gold_signals_found:  parseInt(goldResult.rows[0]?.count ?? '0'),
            avg_return_per_trade: avgReturn,
            cumul_return_pct:    cumulReturnPct,
            total_trades_90d:    totalTrades,
            wins_90d:            wins,
            losses_90d:          losses,
            open_positions:      openPositions,
            open_count:          openPositions.length,
            updated:             new Date().toISOString(),
        });

    } catch (error: any) {
        console.error('[butterfly-stats] DB Error:', error);
        return NextResponse.json({
            error: 'Failed to fetch butterfly stats',
            details: error.message,
            gold_win_rate: 0,
            gold_signals_found: 0,
            avg_return_24h: 0,
            total_trades_90d: 0,
            open_positions: [],
            open_count: 0,
        }, { status: 500 });
    }
}
