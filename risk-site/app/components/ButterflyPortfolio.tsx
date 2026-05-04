import React from 'react';
import { TrendingUp, TrendingDown, Activity, Circle } from 'lucide-react';

interface ButterflyPortfolioProps {
    data: any;
}

export const ButterflyPortfolio: React.FC<ButterflyPortfolioProps> = ({ data }) => {
    const [stats, setStats] = React.useState<any>(null);
    const [loadingStats, setLoadingStats] = React.useState(true);

    React.useEffect(() => {
        const loadStats = () => {
            fetch(`/api/butterfly-stats?t=${Date.now()}`, { cache: 'no-store' })
                .then(res => res.json())
                .then(d => { setStats(d); setLoadingStats(false); })
                .catch(err => { console.error('butterfly-stats failed', err); setLoadingStats(false); });
        };

        loadStats(); // Initial load
        const timer = setInterval(loadStats, 60_000); // Auto-refresh every 60s
        return () => clearInterval(timer);
    }, []);

    if (!data?.signals) return null;

    const openPositions: any[] = stats?.open_positions ?? [];
    const winRateColor = (stats?.gold_win_rate ?? 0) >= 70 ? 'text-emerald-400' : 'text-yellow-400';
    const avgRetColor = (stats?.avg_return_24h ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400';

    return (
        <div className="space-y-6">

            {/* ── STATS BANNER ──────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-400 bg-slate-900/50 p-3 rounded-lg border border-slate-800/50">
                {loadingStats ? (
                    <span className="text-slate-600 text-xs animate-pulse font-mono">Loading live stats...</span>
                ) : (
                    <>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Win Rate (L90D):</span>
                            <span className={`font-mono font-bold ${winRateColor}`}>
                                {stats?.gold_win_rate ?? 0}%
                            </span>
                        </div>
                        <div className="w-px h-3 bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Trades:</span>
                            <span className="font-mono font-bold text-slate-300">
                                <span className="text-emerald-400">{stats?.wins_90d ?? 0}W</span>
                                {' / '}
                                <span className="text-red-400">{stats?.losses_90d ?? 0}L</span>
                            </span>
                        </div>
                        <div className="w-px h-3 bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Avg Return:</span>
                            <span className={`font-mono font-bold ${avgRetColor}`}>
                                {(stats?.avg_return_24h ?? 0) >= 0 ? '+' : ''}{stats?.avg_return_24h ?? 0}%
                            </span>
                        </div>
                        <div className="w-px h-3 bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Gold Signals (24h):</span>
                            <span className="font-mono font-bold text-amber-400">{stats?.gold_signals_found ?? 0}</span>
                        </div>
                        <div className="w-px h-3 bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <Circle size={8} className="text-emerald-500 fill-emerald-500 animate-pulse" />
                            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Open Now:</span>
                            <span className="font-mono font-bold text-emerald-400">{openPositions.length}</span>
                        </div>
                        <div className="w-px h-3 bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Cumul. Return:</span>
                            <span className={`font-mono font-bold ${(stats?.cumul_return_pct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                {(stats?.cumul_return_pct ?? 0) >= 0 ? '+' : ''}{stats?.cumul_return_pct ?? 0}%
                            </span>
                        </div>
                        <span className="ml-auto text-[10px] font-mono text-slate-600 hidden md:block">
                            ↻ {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                    </>
                )}
            </div>

            {/* ── LIVE OPEN POSITIONS TABLE ─────────────────────────────── */}
            {openPositions.length > 0 && (
                <div className="bg-[#0f172a] border border-emerald-900/40 rounded-lg overflow-hidden shadow-xl">
                    <div className="flex items-center gap-3 px-4 py-3 bg-emerald-900/20 border-b border-emerald-900/40">
                        <Activity size={14} className="text-emerald-400 animate-pulse" />
                        <span className="text-xs font-bold text-emerald-400 uppercase tracking-widest">
                            Live Positions — Monitored by Exit Engine
                        </span>
                        <span className="ml-auto text-[10px] font-mono text-emerald-600">
                            LIVE • {new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="bg-slate-900/50 border-b border-slate-800 text-[10px] text-slate-500 uppercase tracking-widest">
                                    <th className="p-3 md:p-4 font-medium">Ticker</th>
                                    <th className="p-3 md:p-4 font-medium">Entry Price</th>
                                    <th className="p-3 md:p-4 font-medium">Peak / Current</th>
                                    <th className="p-3 md:p-4 font-medium">Qty</th>
                                    <th className="p-3 md:p-4 font-medium">Market Value</th>
                                    <th className="p-3 md:p-4 font-medium">Unrealized P&L</th>
                                    <th className="p-3 md:p-4 font-medium">Entry Date</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/50">
                                {openPositions.map((pos: any, idx: number) => {
                                    const isPos = pos.unrealized_pct >= 0;
                                    const entryDate = new Date(pos.entry_date);
                                    return (
                                        <tr key={idx} className="hover:bg-white/5 transition-colors bg-emerald-900/5">
                                            <td className="p-3 md:p-4">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                                                        {pos.ticker.substring(0, 2)}
                                                    </div>
                                                    <span className="font-bold text-sm text-slate-200">{pos.ticker}</span>
                                                </div>
                                            </td>
                                            <td className="p-3 md:p-4 font-mono text-sm text-slate-300">
                                                ${pos.entry_price.toFixed(2)}
                                            </td>
                                            <td className="p-3 md:p-4 font-mono text-sm text-slate-300">
                                                ${pos.peak_price.toFixed(2)}
                                            </td>
                                            <td className="p-3 md:p-4 font-mono text-sm text-slate-400">
                                                {pos.quantity.toLocaleString()}
                                            </td>
                                            <td className="p-3 md:p-4 font-mono text-sm text-slate-300">
                                                ${pos.market_value.toLocaleString()}
                                            </td>
                                            <td className="p-3 md:p-4">
                                                <span className={`flex items-center gap-1 font-mono font-bold text-sm ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
                                                    {isPos ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                                                    {isPos ? '+' : ''}{pos.unrealized_pct}%
                                                </span>
                                            </td>
                                            <td className="p-3 md:p-4 text-[11px] text-slate-500 font-mono">
                                                {entryDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })}
                                                {' '}
                                                {entryDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <div className="p-3 bg-slate-900/30 border-t border-slate-800 text-center">
                        <p className="text-[10px] text-slate-500 uppercase tracking-widest">
                            Exit Engine monitors every 3 min • Peak price tracked for trailing stop • 15% allocation per position
                        </p>
                    </div>
                </div>
            )}

        </div>
    );
};
