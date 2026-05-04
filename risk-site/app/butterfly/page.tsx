"use client";

import React, { useEffect, useState, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import AuthGuard from "../components/AuthGuard";
import { ButterflyPortfolio } from "../components/ButterflyPortfolio";
import { SpeculativePortfolio } from "../components/SpeculativePortfolio";
import { Network, Zap, Activity, Info, X, ShieldCheck, AlertTriangle, Circle, Square, ArrowUpRight } from 'lucide-react';

// Dynamically import ForceGraph2D with no SSR
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
    ssr: false,
    loading: () => <div className="h-64 flex items-center justify-center text-slate-500 font-mono text-xs tracking-widest uppercase">Initializing Neural Map...</div>
});

declare global {
    interface Window {
        d3: any;
    }
}

interface GraphData {
    nodes: any[];
    links: any[];
    signals?: any[];
    regime?: {
        status: string;
        score: number;
        details: any;
    };
}

export default function ButterflyPage() {
    const [data, setData] = useState<GraphData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const graphRef = useRef<any>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(1200);
    const [height, setHeight] = useState(750); // Default Desktop height

    // Filter Logic
    const [activeFilter, setActiveFilter] = useState<number | null>(null);

    // Chaos Simulator State
    const [simulationMode, setSimulationMode] = useState(false);
    const [shockValues, setShockValues] = useState<Record<string, number>>({});
    const [showSimInfo, setShowSimInfo] = useState(false); // Educational Tooltip

    // Feature 2: Hedge Action State
    const [selectedHedgeSignal, setSelectedHedgeSignal] = useState<any | null>(null);

    useEffect(() => {
        if (containerRef.current) {
            // Initial Set
            setWidth(containerRef.current.clientWidth);
            setHeight(containerRef.current.clientHeight);

            let timeoutId: any;
            const resizeObserver = new ResizeObserver(entries => {
                // Debounce resize to prevent jitter/drift resets
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => {
                    for (let entry of entries) {
                        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                            setWidth(entry.contentRect.width);
                            setHeight(entry.contentRect.height);
                        }
                    }
                }, 200);
            });
            resizeObserver.observe(containerRef.current);
            return () => {
                resizeObserver.disconnect();
                clearTimeout(timeoutId);
            };
        }
    }, [containerRef]);

    useEffect(() => {
        const fetchGraph = async () => {
            try {
                // Fetch from new Dynamic API
                // Timestamp to prevent browser caching, but API handles DB query
                const res = await fetch(`/api/graph?t=${Date.now()}`);
                if (res.ok) {
                    const jsonData = await res.json();
                    setData(jsonData);
                } else {
                    const errorText = await res.text();
                    console.error("API Error:", res.statusText, errorText);
                    setError(`API Connection Failed: ${res.status} ${res.statusText} - ${errorText.substring(0, 100)}`);
                }
            } catch (e: any) {
                console.error("Graph fetch failed", e);
                setError(`Connection Error: ${e.message}`);
            }
        };
        fetchGraph();
    }, []);


    // Filter Data Memo (Smart Context)
    const filteredData = useMemo(() => {
        if (!data) return { nodes: [], links: [] };
        if (activeFilter === null) return data;

        // 1. Get all nodes that belong to the selected Primary Group
        const primaryNodes = data.nodes.filter(n => n.group === activeFilter);
        const primaryNodeIds = new Set(primaryNodes.map(n => n.id));

        // 2. Find all links that connect to Selected Primary Nodes (if filter active)
        // AND ensure we filter out "TEST" nodes globally here too
        const relevantLinks = data.links.filter(l => {
            const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
            const targetId = typeof l.target === 'object' ? l.target.id : l.target;

            // GLOBAL FILTER: Exclude TEST or System nodes from graph
            if (sourceId.includes('TEST') || targetId.includes('TEST')) return false;
            if (sourceId === 'TEST_SYS' || targetId === 'TEST_SYS') return false;

            // If no filter, show everything (except tests)
            if (activeFilter === null) return true;

            return primaryNodeIds.has(sourceId) || primaryNodeIds.has(targetId);
        });

        // 3. Collect all Node IDs involved in these links (Source + Target)
        const relevantNodeIds = new Set<string>();
        relevantLinks.forEach(l => {
            const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
            const targetId = typeof l.target === 'object' ? l.target.id : l.target;
            relevantNodeIds.add(sourceId);
            relevantNodeIds.add(targetId);
        });

        // 4. Return the subset of nodes and links
        // Double check nodes doesn't include TEST
        // For the DEFAULT view (activeFilter === null), ONLY show nodes that either:
        // A) Have at least 1 connection (are in relevantNodeIds)
        // B) Have an active Signal (pulse)
        // This hides the 100+ disconnected "orphan" nodes.
        let nodes = data.nodes.filter(n => !n.id.includes('TEST'));

        if (activeFilter === null) {
            nodes = nodes.filter(n => relevantNodeIds.has(n.id) || !!n.signal);
        } else {
            nodes = nodes.filter(n => relevantNodeIds.has(n.id));
        }

        // --- THE NEURAL CORE LAYOUT ---
        // Native injection of fx/fy coordinates at the state level
        // Removed fx/fy logic here, now handled by D3 forces
        nodes = nodes.map(n => n);

        return { nodes, links: relevantLinks };
    }, [data, activeFilter]);

    // Calculate Shock Impact Helper
    const getShockImpact = (nodeId: string, nodeLinks: any[]) => {
        if (!simulationMode || Object.keys(shockValues).length === 0) return 0;

        let impact = 0;
        // In real app, this would be a deep traversal.
        // For visual demo: Check if any neighbor is a Shocked Factor.

        Object.entries(shockValues).forEach(([factorId, shockVal]) => {
            if (shockVal === 0) return;

            // If this node IS the factor, it gets the shock color
            if (nodeId === factorId) {
                impact = shockVal;
                return;
            }

            // Simplified Mock Logic for Demo
            if (factorId === 'Oil_Energy_Prices') {
                if (['ENOG', 'DLEKG', 'ORL'].includes(nodeId)) impact += shockVal; // Positive correlation
                if (['DAL', 'UAL'].includes(nodeId)) impact -= shockVal; // Negative correlation
            }
            if (factorId === 'US_Fed_Rate') {
                if (['NDX', 'WIX', 'NICE'].includes(nodeId)) impact -= shockVal * 1.5; // Tech hates rates
                if (['LEUMI', 'POALIM'].includes(nodeId)) impact += shockVal * 0.5; // Banks like rates
            }
            if (factorId === 'Global_Geopolitics') {
                if (['Elbit', 'Rafael'].includes(nodeId)) impact += shockVal;
                if (['TA35', 'S&P500'].includes(nodeId)) impact -= shockVal * 0.5;
            }
        });

        return impact;
    };

    // Force Graph Configuration (Physics)
    useEffect(() => {
        if (graphRef.current) {
            // 1. Repulsion: Keep nodes inside a group apart
            const chargeForce = graphRef.current.d3Force('charge');
            if (chargeForce) {
                chargeForce.strength(-80); // Softer repulsion for lower-frequency oscillation
                chargeForce.distanceMax(300); // 
            }

            // 2. Link Distance
            const linkForce = graphRef.current.d3Force('link');
            if (linkForce) {
                linkForce.distance(() => 60); // Slightly more relaxed grouping
                linkForce.strength(() => 0.15); // Soft springs for jellyfish-like elasticity
            }

            // 3. Central Mass Gravity (Universal)
            // Replaces the manual velocity loop with D3's optimized native force logic.
            // This prevents harmonic vibration (the "shaking" bug) across the whole network.
            // It applies a gentle, continuous tug to center point (0,0) for all unanchored nodes.
            // When grouped with Link/Charge forces, it smoothly folds isolated islands together.
            if (window.d3) {
                const xForce = graphRef.current.d3Force('x');
                if (!xForce) {
                    graphRef.current.d3Force('x', window.d3.forceX(0).strength(0.02));
                    graphRef.current.d3Force('y', window.d3.forceY(0).strength(0.02));
                }
            } else {
                // Fallback if window.d3 isn't available: a much gentler, non-linear manual force
                graphRef.current.d3Force('gentleGravity', (alpha: number) => {
                    const liveNodes = filteredData.nodes;
                    liveNodes.forEach((node: any) => {
                        if (node.fx !== undefined || node.fy !== undefined) return;
                        // A very soft pull that scales down as it gets closer to 0
                        node.vx -= (node.x * alpha * 0.01);
                        node.vy -= (node.y * alpha * 0.01);
                    });
                });
            }

            const centerForce = graphRef.current.d3Force('center');
            if (centerForce) {
                centerForce.x(0).y(0);
                if (window.innerWidth < 768) {
                    centerForce.strength(1.0);
                } else {
                    centerForce.strength(0.8); // pulls the entire system structure tightly to center
                }
            }

            // Re-heat simulation slightly to apply new forces, then cool down
            graphRef.current.d3ReheatSimulation();
        }
    }, [filteredData, width, height]); // Re-run on data or resize

    const getNodeColor = (node: any) => {
        // 1. Simulation Override
        if (simulationMode) {
            const impact = getShockImpact(node.id, filteredData.links);
            if (impact > 5) return '#4ade80'; // Green (Profit)
            if (impact < -5) return '#ef4444'; // Red (Loss)
            if (impact !== 0) return '#facc15'; // Yellow (Mixed)
        }

        // 2. Alert Overrides - Color by ACTION
        if (node.signal) {
            const action = (node.signal.opportunity?.action || 'NEUTRAL').toUpperCase().trim();
            // DEBUG: Log action for TA35
            if (node.id === 'TA35') console.log(`[DEBUG] TA35 Action: "${action}"`);

            if (['POSITIVE', 'STRONG BUY', 'BUY', 'BULLISH', 'UP'].some(x => action.includes(x))) return '#4ade80'; // Green
            if (['NEGATIVE', 'SELL', 'AVOID', 'EXIT', 'WEAK', 'DOWN', 'BEARISH', 'ALERT'].some(x => action.includes(x))) return '#ef4444'; // Red
            return '#facc15'; // Amber/Yellow
        }

        // 3. Standard Group Colors
        switch (node.group) {
            case 1: return '#64748b'; // Slate (US/IL Tech)
            case 2: return '#0d9488'; // Teal (Energy)
            case 3: return '#3b82f6'; // Blue (Geo/Defense)
            case 4: return '#6366f1'; // Indigo (Finance)
            case 5: return '#d97706'; // Amber (Consumer)
            default: return '#475569';
        }
    };

    return (
        <AuthGuard>
            <div className="min-h-screen bg-[#0B1121] text-gray-200 p-4 md:p-6 font-['Inter']">

                <header className="mb-6 md:mb-8 flex flex-col md:flex-row justify-between items-start md:items-center max-w-7xl mx-auto border-b border-white/5 pb-4 md:pb-6">
                    <div>
                        <div className="flex items-center gap-3 mb-2">
                            <span className="p-2 bg-white/5 rounded-lg border border-white/10">
                                <Network className="w-5 h-5 text-indigo-400" />
                            </span>
                            <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-slate-100">
                                Butterfly Effect Scanner
                            </h1>
                        </div>
                        <p className="text-slate-500 max-w-2xl text-[10px] md:text-xs uppercase tracking-wider font-medium pl-1">
                            Systemic Risk & Correlation Topology <span className="text-indigo-500/50 ml-1">v4.1</span>
                        </p>
                    </div>

                    {/* v4.0 MACRO REGIME BADGE */}
                    {data?.regime && (
                        <div className={`mt-4 md:mt-0 flex items-center gap-3 px-4 py-2 rounded-xl border backdrop-blur-md ${data.regime.status === 'HARD_STOP' ? 'bg-red-500/10 border-red-500/30 text-red-400 shadow-[0_0_15px_rgba(239,68,68,0.2)]' :
                            data.regime.status === 'DEFENSIVE' ? 'bg-amber-500/10 border-amber-500/30 text-amber-400' :
                                ['GREEN', 'RISK_ON'].includes(data.regime.status) ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' :
                                    'bg-slate-500/10 border-slate-500/30 text-slate-400'
                            }`}>
                            <div className={`p-1.5 rounded-full ${data.regime.status === 'HARD_STOP' ? 'bg-red-500/20 animate-pulse' :
                                data.regime.status === 'DEFENSIVE' ? 'bg-amber-500/20' :
                                    ['GREEN', 'RISK_ON'].includes(data.regime.status) ? 'bg-emerald-500/20' :
                                        'bg-slate-500/20'
                                }`}>
                                {data.regime.status === 'HARD_STOP' ? <AlertTriangle size={16} /> :
                                    data.regime.status === 'DEFENSIVE' ? <ShieldCheck size={16} /> :
                                        ['GREEN', 'RISK_ON'].includes(data.regime.status) ? <Activity size={16} /> :
                                            <Info size={16} />}
                            </div>
                            <div>
                                <div className="text-[10px] uppercase tracking-widest opacity-70 font-bold">Market Regime</div>
                                <div className="text-sm font-bold tracking-wide flex items-baseline gap-2">
                                    {data.regime.status.replace('_', ' ')}
                                    <span className="text-[10px] opacity-60 font-mono">({data.regime.score}/100)</span>
                                </div>
                            </div>
                        </div>
                    )}

                </header>

                {/* HEADER: EDUCATIONAL CONTEXT */}
                <div className="mb-6 mx-auto max-w-7xl animate-fade-in hidden md:block">
                    <div className="p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-lg flex items-start gap-4">
                        <div className="p-2 bg-indigo-500/20 rounded-lg text-indigo-400 shrink-0">
                            <Network size={20} />
                        </div>
                        <div>
                            <h2 className="text-sm font-bold text-indigo-300 mb-1">
                                THE DECISION CORE (Butterfly)
                            </h2>
                            <p className="text-xs text-slate-300 max-w-3xl leading-relaxed opacity-90">
                                <b>The Bottom Line.</b> While Global Command shows "The World" and Stocks Watch shows "The Math",
                                this engine integrates both to generate high-conviction <b>Swing Opportunities</b> (The Butterfly Effect).
                                Use the <i>Active Swing Portfolio</i> below for actionable ideas.
                            </p>
                        </div>
                    </div>
                </div>

                <main className="max-w-7xl mx-auto flex flex-col gap-4 md:gap-6">

                    {/* GRAPH SECTION - FULL WIDTH */}
                    <div className="w-full bg-[#0f172a] border border-slate-800/50 rounded-lg overflow-hidden relative shadow-inner">
                        <div ref={containerRef} className="h-[400px] md:h-[750px] w-full bg-[#0f172a] relative transition-all duration-300 ease-out">
                            {/* Manual Center Button */}
                            <button
                                onClick={() => graphRef.current?.zoomToFit(1000, 80)}
                                className="absolute top-4 right-4 z-20 bg-slate-800/80 hover:bg-slate-700 text-slate-300 p-2 rounded-lg border border-slate-700 shadow-lg transition-all"
                                title="Center Graph"
                            >
                                <Network size={18} />
                            </button>

                            {filteredData && (
                                <ForceGraph2D
                                    ref={graphRef}
                                    width={width}
                                    height={height}
                                    graphData={filteredData}

                                    // Custom Canvas Rendering
                                    nodeCanvasObject={(node: any, ctx, globalScale) => {
                                        const label = node.id;
                                        const fontSize = 12 / globalScale;
                                        ctx.font = `${fontSize}px Sans-Serif`;

                                        const color = getNodeColor(node);
                                        const size = (node.val || 5) * 0.5;

                                        // Pulse Effect for Alerts
                                        if (node.signal) {
                                            ctx.beginPath();
                                            ctx.arc(node.x, node.y, size * 1.5 + Math.sin(Date.now() / 200) * 2, 0, 2 * Math.PI, false);
                                            // Dynamic Pulse Color
                                            const action = (node.signal.opportunity?.action || 'NEUTRAL').toUpperCase();
                                            const isPos = ['POSITIVE', 'STRONG BUY', 'BUY', 'BULLISH', 'UP'].some(x => action.includes(x));
                                            ctx.fillStyle = isPos ? "rgba(74, 222, 128, 0.3)" : "rgba(239, 68, 68, 0.3)";
                                            ctx.fill();
                                        }

                                        ctx.fillStyle = color;
                                        ctx.beginPath();

                                        if (node.type === 'FACTOR') {
                                            ctx.rect(node.x - size, node.y - size, size * 2, size * 2);
                                        } else {
                                            ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
                                        }

                                        ctx.fill();

                                        if (globalScale > 1.2 || node.val > 10 || node.signal) {
                                            ctx.textAlign = 'center';
                                            // Label Color: Only show Red/Green if it's a SIGNAL node. Otherwise white.
                                            const isSignal = !!node.signal;
                                            const action = isSignal ? (node.signal.opportunity?.action || 'NEUTRAL').toUpperCase() : '';
                                            const isPos = isSignal && ['POSITIVE', 'STRONG BUY', 'BUY', 'BULLISH', 'UP'].some(x => action.includes(x));

                                            ctx.fillStyle = isSignal
                                                ? (isPos ? '#86efac' : '#fca5a5') // Green or Red
                                                : 'rgba(255, 255, 255, 0.8)'; // Standard White text for non-signals
                                            ctx.fillText(label, node.x, node.y + size + fontSize);
                                        }
                                    }}

                                    nodePointerAreaPaint={(node: any, color, ctx) => {
                                        const size = (node.val || 5) * 0.5;
                                        ctx.fillStyle = color;
                                        ctx.beginPath();
                                        if (node.type === 'FACTOR') {
                                            ctx.rect(node.x - size, node.y - size, size * 2, size * 2);
                                        } else {
                                            ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
                                        }
                                        ctx.fill();
                                    }}

                                    // STRATEGIC RULE VISUALIZATION
                                    linkColor={(link: any) => link.strategic_rule_id ? '#fbbf24' : '#334155'} // Gold for Strategic, Slate for Normal
                                    linkWidth={(link: any) => link.strategic_rule_id ? 2 : 1}
                                    linkLabel={(link: any) => link.strategic_rule_id ? `Strategy: ${link.relationship} (${link.strategic_rule_id})` : link.relationship}
                                    linkDirectionalArrowLength={3.5}
                                    linkDirectionalArrowRelPos={1}
                                    linkDirectionalArrowColor={(link: any) => link.strategic_rule_id ? '#fbbf24' : '#475569'}

                                    linkDirectionalParticles={(link: any) => link.strategic_rule_id ? 4 : (link.target.signal ? 2 : 0)}
                                    linkDirectionalParticleSpeed={(link: any) => link.strategic_rule_id ? 0.005 : 0.002}
                                    linkDirectionalParticleWidth={2}
                                    linkDirectionalParticleColor={(link: any) => link.strategic_rule_id ? '#fbbf24' : '#94a3b8'}

                                    backgroundColor="#0f172a"
                                    d3VelocityDecay={0.8} // High friction/drag for slow underwater motion
                                    d3AlphaDecay={0.005} // Very slow cooling so it drifts smoothly for a long time
                                    warmupTicks={50}
                                    // Enable Physics Dragging
                                    enableNodeDrag={true}
                                    onNodeDragEnd={node => {
                                        // CRITICAL BUGFIX: 
                                        // Do NOT wipe out fx/fy if the node is one of our 5 structural anchors.
                                        // Otherwise, the drag hook deletes the geometry lock and the graph scatters.
                                        const protectedAnchors = ['Tech_AI_Factor', 'US_Fed_Rate', 'Oil_Energy_Prices', 'IL_Inflation_Rate', 'Global_Geopolitics'];

                                        if (!protectedAnchors.includes(node.id)) {
                                            if (node.fx && node.fy) {
                                                node.fx = undefined;
                                                node.fy = undefined;
                                            }
                                        }
                                        // Wakes the physics engine back up
                                        graphRef.current?.d3ReheatSimulation();
                                    }}

                                    onNodeClick={(node: any) => {
                                        if (node.signal) {
                                            alert(`🚨 EARLY SIGNAL DETECTED: \n\n${node.signal.source}: ${node.signal.message}`);
                                        }
                                        // Removed forced camera zoom and center that accidentally triggered on drag drop
                                    }}
                                />
                            )}
                        </div>
                    </div>

                    {/* CONTROLS & LEGEND - COMPACT SAAS LAYOUT */}
                    <div className="w-full bg-[#0f172a] border border-slate-800/50 p-3 rounded-lg flex flex-col md:flex-row items-center justify-between gap-4 md:gap-8">

                        {/* LEFT: Filter by Sector */}
                        <div className="flex items-center gap-4 overflow-x-auto no-scrollbar">
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap border-r border-slate-800 pr-4">Filter View</span>
                            <div className="flex items-center gap-3">
                                <LegendItem color="#64748b" label="Tech" isActive={activeFilter === 1} onClick={() => setActiveFilter(activeFilter === 1 ? null : 1)} />
                                <LegendItem color="#0d9488" label="Energy" isActive={activeFilter === 2} onClick={() => setActiveFilter(activeFilter === 2 ? null : 2)} />
                                <LegendItem color="#3b82f6" label="Defense" isActive={activeFilter === 3} onClick={() => setActiveFilter(activeFilter === 3 ? null : 3)} />
                                <LegendItem color="#6366f1" label="Finance" isActive={activeFilter === 4} onClick={() => setActiveFilter(activeFilter === 4 ? null : 4)} />
                                <LegendItem color="#d97706" label="Consumer" isActive={activeFilter === 5} onClick={() => setActiveFilter(activeFilter === 5 ? null : 5)} />
                            </div>
                            {activeFilter !== null && (
                                <button
                                    onClick={() => setActiveFilter(null)}
                                    className="text-[10px] text-indigo-400 hover:text-white transition-colors ml-2 whitespace-nowrap"
                                >
                                    ✕ CLEAR
                                </button>
                            )}
                        </div>

                        {/* RIGHT: Topology Key */}
                        <div className="flex items-center gap-4 pl-4 md:border-l border-slate-800">
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap hidden lg:block">Legend</span>
                            <div className="flex items-center gap-4">
                                <div className="flex gap-1.5 text-[10px] text-slate-400 items-center">
                                    <Circle size={10} className="text-slate-400" fill="currentColor" fillOpacity={0.2} />
                                    <span>Stock</span>
                                </div>
                                <div className="flex gap-1.5 text-[10px] text-slate-400 items-center">
                                    <Square size={10} className="text-slate-400" fill="currentColor" fillOpacity={0.2} />
                                    <span>Factor</span>
                                </div>
                                <div className="flex gap-1.5 text-[10px] text-slate-400 items-center">
                                    <ArrowUpRight size={10} />
                                    <span>Causal</span>
                                </div>
                                <div className="flex gap-1.5 text-[10px] text-red-400 items-center">
                                    <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                                    <span>Anomaly</span>
                                </div>
                            </div>
                        </div>
                    </div>

                </main>

                {/* COMMAND CONSOLE (Live Market Log) */}
                <section className="max-w-7xl mx-auto mt-6 mb-8 animate-slide-up">
                    <div className="bg-black/90 border border-slate-800 rounded-lg p-4 shadow-2xl relative overflow-hidden group">
                        {/* Decorative Scan Line */}
                        <div className="absolute inset-0 bg-[linear-gradient(transparent_0%,rgba(34,197,94,0.05)_50%,transparent_100%)] bg-[length:100%_4px] animate-scan pointer-events-none"></div>

                        <div className="flex items-center justify-between mb-3 border-b border-white/10 pb-2">
                            <div className="flex items-center gap-2 font-mono text-xs text-emerald-500 font-bold uppercase tracking-widest">
                                <Activity size={14} className="animate-pulse" />
                                מערכת בקרה בזמן אמת // יומן אירועים
                            </div>
                            <div className="text-[10px] text-slate-500 font-mono">
                                סטטוס: מנטר [פעיל]
                            </div>
                        </div>

                        <div className="h-64 md:h-80 overflow-y-auto custom-scrollbar font-mono text-xs space-y-2 pr-2 overscroll-contain" data-lenis-prevent dir="rtl">
                            {data?.signals && data.signals.length > 0 ? (
                                <>
                                    {[...data.signals]
                                        .sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0))
                                        .reverse()
                                        .map((sig: any, idx: number) => (
                                            <div key={idx} className="flex items-start gap-4 hover:bg-white/5 p-1 rounded transition-colors group/item">
                                                <span className="text-slate-500 min-w-[90px] font-mono whitespace-nowrap pt-0.5 text-left">
                                                    {sig.date_display || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })} {sig.time_offset}
                                                </span>
                                                <span className={`min-w-[60px] font-bold whitespace-nowrap pt-0.5 ${(() => {
                                                    const action = (sig.opportunity?.action || '').toUpperCase();
                                                    if (['POSITIVE', 'STRONG BUY', 'BUY', 'BULLISH', 'UP'].some(x => action.includes(x))) return 'text-emerald-400';
                                                    if (['NEGATIVE', 'SELL', 'AVOID', 'EXIT', 'WEAK', 'DOWN', 'BEARISH', 'ALERT'].some(x => action.includes(x))) return 'text-red-400';
                                                    return 'text-slate-400'; // Default
                                                })()
                                                    }`}>
                                                    {sig.target}
                                                </span>

                                                <div className="flex flex-col flex-1 min-w-0 mr-4">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-indigo-400 font-mono text-[10px] whitespace-nowrap border border-indigo-500/30 px-1 rounded bg-indigo-500/10">[{sig.type.replace('_NEWS', '')}]</span>
                                                        {/* DOMINO BADGE */}
                                                        {(sig.source === 'DOMINO' || sig.type === 'DOMINO_EFFECT') && (
                                                            <span className="text-amber-400 font-mono text-[9px] whitespace-nowrap border border-amber-500/30 px-1 rounded bg-amber-500/10 flex items-center gap-1">
                                                                🎲 DOMINO
                                                            </span>
                                                        )}
                                                        <span className="text-slate-300 font-medium truncate">{sig.message}</span>
                                                    </div>

                                                    {/* AI INSIGHT DISPLAY */}
                                                    {sig.ai_insight && (
                                                        <div className={`flex items-start gap-1 mt-1 pr-1 border-r-2 mr-1 ${(() => {
                                                            const action = (sig.opportunity?.action || '').toUpperCase();
                                                            if (['POSITIVE', 'STRONG BUY', 'BUY', 'BULLISH', 'UP'].some(x => action.includes(x))) return 'border-emerald-500/30';
                                                            if (['NEGATIVE', 'SELL', 'AVOID', 'EXIT', 'WEAK', 'DOWN', 'BEARISH', 'ALERT'].some(x => action.includes(x))) return 'border-red-500/30';
                                                            return 'border-zinc-500/30';
                                                        })()
                                                            }`}>
                                                            <span className={`text-[10px] font-bold whitespace-nowrap ml-1 ${(() => {
                                                                const action = (sig.opportunity?.action || '').toUpperCase();
                                                                if (['POSITIVE', 'STRONG BUY', 'BUY', 'BULLISH', 'UP'].some(x => action.includes(x))) return 'text-emerald-500/70';
                                                                if (['NEGATIVE', 'SELL', 'AVOID', 'EXIT', 'WEAK', 'DOWN', 'BEARISH', 'ALERT'].some(x => action.includes(x))) return 'text-red-500/70';
                                                                return 'text-zinc-500/70';
                                                            })()
                                                                }`}>ניתוח AI ↦</span>
                                                            <span className={`text-[10px] italic leading-tight ${(() => {
                                                                const action = (sig.opportunity?.action || '').toUpperCase();
                                                                if (['POSITIVE', 'STRONG BUY', 'BUY', 'BULLISH', 'UP'].some(x => action.includes(x))) return 'text-emerald-400/90';
                                                                if (['NEGATIVE', 'SELL', 'AVOID', 'EXIT', 'WEAK', 'DOWN', 'BEARISH', 'ALERT'].some(x => action.includes(x))) return 'text-red-400/90';
                                                                return 'text-zinc-400/90';
                                                            })()
                                                                }`}>
                                                                {sig.ai_insight}
                                                            </span>
                                                        </div>
                                                    )}

                                                    {/* v2.5 VISION & SEC BADGES */}
                                                    <div className="flex flex-wrap gap-2 mt-1.5">
                                                        {sig.vision_analysis && sig.vision_analysis.visual_score > 75 && (
                                                            <div className="flex items-center gap-1 bg-indigo-500/10 border border-indigo-500/30 px-1.5 py-0.5 rounded text-[9px] text-indigo-300">
                                                                <span>👁️</span>
                                                                <span className="font-bold">VISION: {sig.vision_analysis.technical_pattern}</span>
                                                                <span className="opacity-70">({sig.vision_analysis.visual_score})</span>
                                                            </div>
                                                        )}
                                                        {sig.sec_context && (
                                                            <a href={sig.sec_context.link || '#'} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded text-[9px] text-amber-300 hover:bg-amber-500/20 transition-colors">
                                                                <span>👃</span>
                                                                <span className="font-bold">SEC: {sig.sec_context.form_type}</span>
                                                            </a>
                                                        )}
                                                        {/* Fallback for raw SEC source */}
                                                        {sig.source === 'SEC_EDGAR' && !sig.sec_context && (
                                                            <div className="flex items-center gap-1 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded text-[9px] text-amber-300">
                                                                <span>👃</span>
                                                                <span className="font-bold">SEC FILING</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                                {/* Action Button that appears on hover */}
                                                <button
                                                    onClick={() => setSelectedHedgeSignal(sig)}
                                                    className="opacity-0 group-hover/item:opacity-100 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded text-[10px] border border-emerald-500/30 transition-all uppercase tracking-wider font-bold"
                                                >
                                                    פעולה
                                                </button>
                                            </div>
                                        ))}
                                    <div className="text-slate-600 pt-2 border-t border-white/5 mt-2 italic text-center">
                                        סוף אירועים. ממתין לעדכונים חדשים...
                                    </div>
                                </>
                            ) : error ? (
                                <div className="text-red-400 font-mono text-xs p-4 border border-red-500/30 rounded bg-red-500/10 text-center" dir="ltr">
                                    <AlertTriangle className="mx-auto mb-2 text-red-500" size={24} />
                                    <p className="font-bold">SYSTEM ERROR</p>
                                    <p>{error}</p>
                                    <p className="mt-2 text-[10px] text-red-300">Please check Vercel Environment Variables (DATABASE_URL).</p>
                                </div>
                            ) : (
                                <div className="text-slate-500 italic flex items-center gap-2 justify-center">
                                    <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                                    יוצר קשר מאובטח עם רשת הפרפר...
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {/* BOTTOM: SWING TRADING PORTFOLIO (The "Model Portfolio") */}
                {data?.signals && data.signals.length > 0 && (
                    <section className="max-w-7xl mx-auto mt-8 animate-slide-up pb-20">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-3">
                                <span className="p-1.5 bg-emerald-500/10 rounded border border-emerald-500/20">
                                    <ShieldCheck size={16} className="text-emerald-500" />
                                </span>
                                <div>
                                    <h2 className="text-lg font-semibold text-slate-200 tracking-tight">Active Swing Portfolio</h2>
                                    <p className="text-[10px] text-slate-500 uppercase tracking-widest font-medium">Top Picks for Multi-Week Holding</p>
                                </div>
                            </div>
                        </div>

                        {/* HIGH DENSITY TABLE */}
                        <ButterflyPortfolio data={data} />

                        {/* SPECULATIVE LAYER MIRROR — independent engine, same UI grammar */}
                        <SpeculativePortfolio />
                    </section>
                )}

                {/* CHAOS SIMULATOR CONTROLS (Feature 1) */}
                <div className="fixed bottom-6 right-6 z-50">
                    {!simulationMode ? (
                        <button
                            onClick={() => setSimulationMode(true)}
                            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-3 rounded-full shadow-lg shadow-indigo-900/50 transition-all transform hover:scale-105 font-medium text-sm"
                        >
                            <Activity size={18} />
                            Launch Simulator
                        </button>
                    ) : (
                        <div className="bg-slate-900/95 border border-indigo-500/30 rounded-xl p-5 shadow-2xl w-80 backdrop-blur-md animate-slide-up">
                            <div className="flex justify-between items-start mb-4 border-b border-indigo-500/20 pb-2">
                                <div>
                                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                                        <Activity size={16} className="text-indigo-400" />
                                        Chaos Simulator
                                    </h3>
                                    {!showSimInfo && <p className="text-[10px] text-slate-500">Institutional Stress Testing (VaR)</p>}
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={() => setShowSimInfo(!showSimInfo)} className="text-indigo-400 hover:text-indigo-300">
                                        <Info size={16} />
                                    </button>
                                    <button onClick={() => { setSimulationMode(false); setShockValues({}); }} className="text-slate-500 hover:text-white">
                                        <X size={16} />
                                    </button>
                                </div>
                            </div>

                            {/* EDUCATIONAL LAYER */}
                            {showSimInfo && (
                                <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-lg p-3 mb-4 animate-fade-in">
                                    <h4 className="text-[11px] font-bold text-indigo-300 mb-1">Why use this?</h4>
                                    <p className="text-[10px] text-slate-300 leading-relaxed">
                                        Professional Risk Managers (like at BlackRock) don't guess—they <b>test</b>.
                                        This simulator mimics a "Stress Test", showing how your portfolio would bleed (Red) or profit (Green) if extreme macro events happen <b>today</b>.
                                    </p>
                                </div>
                            )}

                            <div className="space-y-5">
                                <ShockSlider
                                    label="Oil Prices (Energy Shock)"
                                    value={shockValues['Oil_Energy_Prices'] || 0}
                                    onChange={(val) => setShockValues(prev => ({ ...prev, 'Oil_Energy_Prices': val }))}
                                    color="#f59e0b"
                                />
                                <ShockSlider
                                    label="Fed Rates (Liquidity Crunch)"
                                    value={shockValues['US_Fed_Rate'] || 0}
                                    onChange={(val) => setShockValues(prev => ({ ...prev, 'US_Fed_Rate': val }))}
                                    color="#ef4444"
                                />
                                <ShockSlider
                                    label="Geopolitical Tension"
                                    value={shockValues['Global_Geopolitics'] || 0}
                                    onChange={(val) => setShockValues(prev => ({ ...prev, 'Global_Geopolitics': val }))}
                                    color="#8b5cf6"
                                />
                            </div>

                            <div className="mt-4 pt-3 border-t border-white/5 text-[10px] text-slate-400 text-center">
                                Adjust sliders to propagate shocks across the topology.
                            </div>
                        </div>
                    )}
                </div>

                {/* OPPORTUNITY ANALYSIS MODAL (Swing Trading Details) */}
                {selectedHedgeSignal && (
                    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in">
                        <div className="bg-[#0f172a] border border-slate-700 rounded-xl shadow-2xl max-w-lg w-full overflow-hidden">
                            {/* Header */}
                            <div className="bg-indigo-500/10 border-b border-indigo-500/20 p-5 flex justify-between items-center">
                                <div>
                                    <h3 className="text-indigo-400 font-bold flex items-center gap-2 text-lg">
                                        <Zap size={18} /> SIGNAL CONTEXT ANALYSIS
                                    </h3>
                                    <p className="text-xs text-slate-400 mt-1">Deep Dive for {selectedHedgeSignal.target}</p>
                                </div>
                                <button onClick={() => setSelectedHedgeSignal(null)} className="text-slate-500 hover:text-white bg-slate-800 p-1 rounded-full"><X size={18} /></button>
                            </div>

                            <div className="p-6 space-y-6">
                                {/* Core Signal Box */}
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="bg-slate-900 rounded-lg p-3 border border-slate-800">
                                        <span className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Signal Direction</span>
                                        <span className={`text-lg font-bold ${['POSITIVE', 'STRONG BUY'].includes(selectedHedgeSignal.opportunity?.action) ? 'text-emerald-400' : 'text-slate-200'
                                            }`}>
                                            {selectedHedgeSignal.opportunity?.action}
                                        </span>
                                    </div>
                                    <div className="bg-slate-900 rounded-lg p-3 border border-slate-800">
                                        <span className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Time Horizon</span>
                                        <span className="text-lg font-mono text-slate-200">
                                            {selectedHedgeSignal.opportunity?.horizon}
                                        </span>
                                    </div>
                                </div>

                                {/* The Thesis */}
                                <div>
                                    <h4 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                                        <span className="w-1 h-4 bg-indigo-500 rounded-full"></span>
                                        Investment Thesis
                                    </h4>
                                    <div className="bg-slate-800/30 rounded-lg p-4 border border-slate-800/50">
                                        <p className="text-sm text-slate-300 leading-relaxed font-light whitespace-pre-line">
                                            {selectedHedgeSignal.opportunity?.thesis || selectedHedgeSignal.message}
                                        </p>
                                    </div>
                                </div>

                                {/* AI Context */}
                                {selectedHedgeSignal.ai_insight && (
                                    <div>
                                        <h4 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                                            <span className="w-1 h-4 bg-emerald-500 rounded-full"></span>
                                            AI Context
                                        </h4>
                                        <ul className="space-y-2">
                                            <li className="flex gap-3 text-xs text-slate-400">
                                                <span className="text-emerald-500 font-bold shrink-0">DRIVER:</span>
                                                {selectedHedgeSignal.ai_insight}
                                            </li>
                                            <li className="flex gap-3 text-xs text-slate-400">
                                                <span className="text-indigo-400 font-bold shrink-0">IMPACT:</span>
                                                {selectedHedgeSignal.predicted_impact}
                                            </li>
                                        </ul>
                                    </div>
                                )}

                                <div className="pt-4 border-t border-slate-800">
                                    <div className="flex justify-end gap-3">
                                        <button
                                            onClick={() => setSelectedHedgeSignal(null)}
                                            className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white transition-colors"
                                        >
                                            CLOSE
                                        </button>
                                        <button
                                            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded shadow-lg shadow-indigo-900/50 transition-all transform hover:scale-105"
                                        >
                                            ADD TO WATCHLIST
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </AuthGuard>
    );
}

// Helper Components
function ShockSlider({ label, value, onChange, color }: { label: string, value: number, onChange: (v: number) => void, color: string }) {
    return (
        <div>
            <div className="flex justify-between text-xs mb-1.5 font-medium">
                <span className="text-slate-300">{label}</span>
                <span style={{ color: value > 0 ? '#4ade80' : value < 0 ? '#ef4444' : '#94a3b8' }}>
                    {value > 0 ? '+' : ''}{value}%
                </span>
            </div>
            <input
                type="range"
                min="-50"
                max="50"
                step="5"
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
        </div>
    );
}

function LegendItem({ color, label, isActive, onClick }: { color: string, label: string, isActive: boolean, onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`w-full flex items-center gap-3 p-2 rounded transition-all ${isActive ? 'bg-white/10 ring-1 ring-white/20' : 'hover:bg-white/5'}`}
        >
            <span className={`w-2.5 h-2.5 rounded-full shadow-[0_0_8px]`} style={{ backgroundColor: color, boxShadow: `0 0 ${isActive ? '10px' : '0px'} ${color}` }}></span>
            <span className={`text-xs font-medium transition-colors ${isActive ? 'text-white' : 'text-slate-400'}`}>{label}</span>
        </button>
    );
}
