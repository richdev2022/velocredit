// ============================================================================
// src/components/admin/Charts.tsx
// Lightweight SVG charts (no external dependency) for the admin dashboard.
// ============================================================================

import React from "react";

// --------------------------------------------------------------------------
// LineChart — multi-series SVG line chart with grid + axis labels.
// --------------------------------------------------------------------------

export interface LineSeries {
  label: string;
  color: string;
  values: number[];
}

export function LineChart({
  series,
  labels,
  height = 220,
  formatValue = (n: number) => String(n),
}: {
  series: LineSeries[];
  labels: string[];
  height?: number;
  formatValue?: (n: number) => string;
}) {
  const width = 640;
  const padding = { top: 16, right: 16, bottom: 28, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const allValues = series.flatMap((s) => s.values);
  const maxVal = Math.max(1, ...allValues);
  const minVal = 0;
  const range = Math.max(1, maxVal - minVal);

  const pointCount = labels.length;
  const xStep = pointCount > 1 ? plotW / (pointCount - 1) : 0;

  function x(i: number): number {
    return padding.left + i * xStep;
  }
  function y(v: number): number {
    return padding.top + plotH - ((v - minVal) / range) * plotH;
  }

  // Build "M x0 y0 L x1 y1 ..." path for each series.
  const paths = series.map((s) => {
    if (s.values.length === 0) return { ...s, path: "", area: "" };
    const pts = s.values.map((v, i) => `${x(i)},${y(v)}`);
    const path = `M ${pts.join(" L ")}`;
    // Area under the line (for nice visual fill).
    const area = `${path} L ${x(s.values.length - 1)},${padding.top + plotH} L ${x(0)},${padding.top + plotH} Z`;
    return { ...s, path, area };
  });

  // Y-axis ticks (4 lines).
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: padding.top + plotH - t * plotH,
    value: minVal + t * range,
  }));

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Line chart">
        {/* Grid lines */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padding.left} y1={t.y} x2={width - padding.right} y2={t.y} stroke="currentColor" strokeWidth={1} className="text-slate-200 dark:text-slate-700" />
            <text x={padding.left - 6} y={t.y + 4} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={10}>
              {formatValue(t.value)}
            </text>
          </g>
        ))}
        {/* X-axis labels */}
        {labels.map((label, i) => {
          // Show every Nth label to avoid crowding.
          const showEvery = Math.max(1, Math.ceil(labels.length / 7));
          if (i % showEvery !== 0 && i !== labels.length - 1) return null;
          return (
            <text key={i} x={x(i)} y={height - 8} textAnchor="middle" className="fill-slate-400 dark:fill-slate-500" fontSize={10}>
              {label}
            </text>
          );
        })}
        {/* Area + line per series */}
        {paths.map((p, idx) => (
          <g key={idx}>
            <path d={p.area} fill={p.color} opacity={0.08} />
            <path d={p.path} fill="none" stroke={p.color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            {/* Points */}
            {p.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={p.color} />
            ))}
          </g>
        ))}
      </svg>
      {/* Legend */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        {series.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// DonutChart — SVG donut chart with legend.
// --------------------------------------------------------------------------

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export function DonutChart({ slices, size = 180 }: { slices: DonutSlice[]; size?: number }) {
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const radius = size / 2;
  const innerRadius = radius * 0.62;
  const cx = radius;
  const cy = radius;

  function arcPath(startAngle: number, endAngle: number, outer: number, inner: number): string {
    const x1 = cx + outer * Math.cos(startAngle);
    const y1 = cy + outer * Math.sin(startAngle);
    const x2 = cx + outer * Math.cos(endAngle);
    const y2 = cy + outer * Math.sin(endAngle);
    const x3 = cx + inner * Math.cos(endAngle);
    const y3 = cy + inner * Math.sin(endAngle);
    const x4 = cx + inner * Math.cos(startAngle);
    const y4 = cy + inner * Math.sin(startAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    return `M ${x1} ${y1} A ${outer} ${outer} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${largeArc} 0 ${x4} ${y4} Z`;
  }

  let angle = -Math.PI / 2; // start at top
  const arcs = slices.map((s) => {
    const value = Math.max(0, Number(s?.value) || 0);
    if (total === 0 || value === 0) return { ...s, path: "", percent: 0 };
    const sweep = (value / total) * Math.PI * 2;
    const path = arcPath(angle, angle + sweep, radius, innerRadius);
    angle += sweep;
    return { ...s, path, percent: (value / total) * 100 };
  });

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Donut chart">
        {total === 0 ? (
          <circle cx={cx} cy={cy} r={radius} fill="none" stroke="currentColor" strokeWidth={radius - innerRadius} className="text-slate-200 dark:text-slate-700" />
        ) : (
          arcs.map((a, i) => a.path ? <path key={i} d={a.path} fill={a.color} /> : null)
        )}
        <text x={cx} y={cy - 4} textAnchor="middle" className="fill-slate-500 dark:fill-slate-400" fontSize={11} fontWeight={700}>
          {total === 0 ? "No data" : "Total"}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="fill-slate-900 dark:fill-white" fontSize={16} fontWeight={800}>
          {total === 0 ? "—" : String(total)}
        </text>
      </svg>
      <div className="flex-1 space-y-1.5 w-full">
        {arcs.map((a, i) => (
          <div key={i} className="flex items-center justify-between gap-3 text-xs">
            <span className="inline-flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: a.color }} />
              {a.label}
            </span>
            <span className="font-semibold text-velo-900 dark:text-white">
              {(Number.isFinite(Number(a.value)) ? Number(a.value) : 0).toLocaleString()} <span className="text-slate-400 dark:text-slate-500">({(Number.isFinite(Number(a.percent)) ? Number(a.percent) : 0).toFixed(0)}%)</span>
            </span>
          </div>
        ))}
        {arcs.length === 0 && (
          <div className="text-xs text-slate-500 dark:text-slate-400">No portfolio data yet.</div>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// BarChart — grouped vertical bars (for loan activity).
// --------------------------------------------------------------------------

export interface BarGroup {
  label: string;
  bars: Array<{ value: number; color: string; sublabel?: string }>;
}

export function BarChart({ groups, height = 220, formatValue = (n: number) => String(n) }: { groups: BarGroup[]; height?: number; formatValue?: (n: number) => string }) {
  const width = 640;
  const padding = { top: 16, right: 16, bottom: 28, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const maxVal = Math.max(1, ...groups.flatMap((g) => g.bars.map((b) => b.value)));
  const groupCount = groups.length;
  const groupW = groupCount > 0 ? plotW / groupCount : plotW;
  const barCount = groups[0]?.bars.length ?? 1;
  const barW = Math.max(4, (groupW * 0.7) / Math.max(1, barCount));
  const intraGap = 2;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: padding.top + plotH - t * plotH,
    value: t * maxVal,
  }));

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Bar chart">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padding.left} y1={t.y} x2={width - padding.right} y2={t.y} stroke="currentColor" strokeWidth={1} className="text-slate-200 dark:text-slate-700" />
            <text x={padding.left - 6} y={t.y + 4} textAnchor="end" className="fill-slate-400 dark:fill-slate-500" fontSize={10}>
              {formatValue(t.value)}
            </text>
          </g>
        ))}
        {groups.map((g, gi) => {
          const groupX = padding.left + gi * groupW;
          const groupCenter = groupX + groupW / 2;
          const totalBarsW = barCount * barW + (barCount - 1) * intraGap;
          const startX = groupCenter - totalBarsW / 2;
          return (
            <g key={gi}>
              {g.bars.map((b, bi) => {
                const h = (b.value / maxVal) * plotH;
                const x = startX + bi * (barW + intraGap);
                const y = padding.top + plotH - h;
                return <rect key={bi} x={x} y={y} width={barW} height={Math.max(0, h)} fill={b.color} rx={2} />;
              })}
              <text x={groupCenter} y={height - 8} textAnchor="middle" className="fill-slate-400 dark:fill-slate-500" fontSize={10}>
                {g.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
