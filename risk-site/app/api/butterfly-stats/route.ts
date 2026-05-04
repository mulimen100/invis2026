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
        const closedResult = await sql`
            SELECT ticker, entry_price, peak_price, quantity, exit_reason, entry_date, exit_date
            FROM positions
            WHERE status = 'CLOSED'
              AND entry_price > 0
              AND entry_date >= '2026-04-09'
              AND exit_reason NOT ILIKE '%GHOST%'
              AND exit_reason NOT ILIKE '%ADVISORY%'
              AND exit_reason NOT ILIKE '%RECONCILER%'
              AND exit_reason NOT ILIKE '%STATS_RESET%'
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
        // We use peak_price as proxy for exit_price (no exit_price column yet).
        // Apply per-reason correction so the estimated exit reflects how much
        // we actually slipped from the peak:
        //   TRAILING_STOP        → peak * 0.97   (3% trail)
        //   DYNAMIC_TAKE_PROFIT  → peak * 0.995  (0.5% trail in RTH; conservative)
        //   TAKE_PROFIT (+8%)    → peak as-is    (true take-profit hit)
        // Then classify W/L by REALISED P&L sign, not by exit reason category.
        // (A "DYNAMIC_TAKE_PROFIT" that exits below entry due to extended-hours
        //  slippage is a loss, not a win.)
        let wins = 0;
        let losses = 0;
        let totalReturnPct = 0;

        for (const pos of closedResult.rows) {
            const reason = (pos.exit_reason || '').toUpperCase();
            const ep = parseFloat(pos.entry_price) || 0;
            const pp = parseFloat(pos.peak_price)  || ep;
            if (ep <= 0) continue;

            const isTrailing = reason.includes('TRAILING_STOP');
            const isDpt      = reason.includes('DYNAMIC_TAKE_PROFIT');
            const isTakeProfit = reason.includes('TAKE_PROFIT') && !isDpt;
            const isRotation = reason.includes('ROTATION');
            const isHardLoss =
                reason.includes('STOP_LOSS') ||
                reason.includes('EMERGENCY') ||
                reason.includes('HARD_STOP');

            // Decide a slippage-adjusted exit estimate
            let exitEstimate = pp;
            if (isTrailing)   exitEstimate = pp * 0.97;
            else if (isDpt)   exitEstimate = pp * 0.995;
            // For TAKE_PROFIT and ROTATION we keep peak as-is (close to actual fill)

            // Hard losses keep the legacy "-2%" assumption (no peak data needed)
            if (isHardLoss) {
                losses++;
                totalReturnPct -= 2.0;
                continue;
            }

            // Skip exits we cannot classify (manual/admin/etc)
            if (!(isTrailing || isDpt || isTakeProfit || isRotation)) {
                continue;
            }

            const retPct = ((exitEstimate - ep) / ep) * 100;
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
