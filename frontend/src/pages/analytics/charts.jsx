import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { inr } from '@/lib/money';

// ── formatting ───────────────────────────────────────────────
export function duration(secs) {
  if (secs == null) return '—';
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  if (s < 3600) { const m = Math.floor(s / 60); const r = s % 60; return r ? `${m}m ${r}s` : `${m}m`; }
  const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
export const rupees = (v, paise = false) => (v == null ? '—' : paise ? `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : inr(v));
export const percent = (v) => (v == null ? '—' : `${v}%`);
export const count = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'));
/** Compact axis labels: 12k, 1.2L. */
export function compact(v, money) {
  const n = Math.abs(v); const p = money ? '₹' : '';
  if (n >= 100000) return `${p}${+(v / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${p}${+(v / 1000).toFixed(1)}k`;
  return `${p}${+v.toFixed(n < 10 && n % 1 ? 2 : 0)}`;
}
const dayLabel = (d, opts = { day: 'numeric', month: 'short' }) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', opts);

// ── stat tile with change vs previous period ─────────────────
/**
 * @param {'up'|'down'} better  which direction is good (reply time and AI cost: down)
 */
export function Stat({ label, value, sub, now, before, better = 'up', className }) {
  let delta = null;
  if (now != null && before != null && Number(now) !== Number(before)) {
    const up = Number(now) > Number(before);
    const good = up === (better === 'up');
    const rel = Number(before) ? Math.round(((Number(now) - Number(before)) / Math.abs(Number(before))) * 100) : null;
    delta = (
      <span className={cn('inline-flex items-center gap-0.5 text-xs font-bold', good ? 'text-success' : 'text-destructive')}>
        {up ? <ArrowUp size={12} weight="bold" aria-hidden /> : <ArrowDown size={12} weight="bold" aria-hidden />}
        {rel == null ? 'new' : `${Math.abs(rel)}%`}
        <span className="sr-only">{up ? 'up' : 'down'} on the previous period</span>
      </span>
    );
  }
  return (
    <div className={cn('rounded-xl border bg-card p-4', className)}>
      <p className="text-xs font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-extrabold tracking-tight tabular-nums">{value}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">{delta}{sub && <span>{sub}</span>}</p>
    </div>
  );
}

// ── daily column chart (one series, hover tooltip) ───────────
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * @param {{day:string, value:number}[]} data
 * @param {(v:number)=>string} format  tooltip value
 */
export function DailyColumns({ data, format, money, label, height = 220 }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const padL = 44; const padB = 24; const padT = 8;
  const plotW = Math.max(0, width - padL - 4); const plotH = height - padB - padT;
  const values = data.map((d) => d.value);
  const max = niceMax(Math.max(0, ...values));
  const min = Math.min(0, ...values) < 0 ? -niceMax(-Math.min(...values)) : 0;
  const span = max - min || 1;
  const y = (v) => padT + ((max - v) / span) * plotH;
  const step = data.length ? plotW / data.length : 0;
  const gap = step > 6 ? 2 : 1;
  const barW = Math.max(1, step - gap);
  const ticks = [max, max / 2, 0].concat(min < 0 ? [min] : []);
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56))));
  const r = Math.min(4, barW / 2);

  const col = (d, i) => {
    const x = padL + i * step + gap / 2;
    const v = d.value;
    if (!v) return null;
    const top = y(Math.max(v, 0)); const bottom = y(Math.min(v, 0));
    const h = Math.max(1, bottom - top);
    // rounded end away from the baseline
    const path = v > 0
      ? `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${bottom} Z`
      : `M${x},${top} V${bottom - r} Q${x},${bottom} ${x + r},${bottom} H${x + barW - r} Q${x + barW},${bottom} ${x + barW},${bottom - r} V${top} Z`;
    return <path key={d.day} d={h < r * 2 ? `M${x},${top} h${barW} v${h} h${-barW} Z` : path} className={cn('fill-primary transition-opacity', hover != null && hover !== i && 'opacity-40')} />;
  };

  const hd = hover != null ? data[hover] : null;
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${label} per day`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width - 4} y1={y(t)} y2={y(t)} className={t === 0 ? 'stroke-border' : 'stroke-border/60'} strokeDasharray={t === 0 ? undefined : '3 3'} />
              <text x={padL - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">{compact(t, money)}</text>
            </g>
          ))}
          {data.map(col)}
          {data.map((d, i) => (i % labelEvery === 0 ? (
            <text key={d.day} x={padL + i * step + step / 2} y={height - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">{dayLabel(d.day)}</text>
          ) : null))}
          {data.map((d, i) => (
            <rect key={d.day} x={padL + i * step} y={padT} width={step} height={plotH} fill="transparent"
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={-1} />
          ))}
        </svg>
      )}
      {hd && (
        <div className="pointer-events-none absolute top-0 z-10 rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: Math.min(Math.max(0, padL + hover * step + step / 2 - 60), Math.max(0, width - 120)) }}>
          <p className="text-muted-foreground">{dayLabel(hd.day, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
          <p className="font-bold tabular-nums">{format(hd.value)} <span className="font-normal text-muted-foreground">{label.toLowerCase()}</span></p>
        </div>
      )}
    </div>
  );
}

// ── horizontal bars (funnel, breakdowns) ─────────────────────
/** rows: [{ label, value, note? }]; bars are scaled to `max` (default: largest value). */
export function Bars({ rows, max, format = count, empty = 'Nothing in this period.' }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${format(r.value)}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 font-bold tabular-nums">{format(r.value)}{r.note && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{r.note}</span>}</span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div className="h-2 rounded-full bg-primary" style={{ width: `${top ? Math.max(r.value > 0 ? 1.5 : 0, (r.value / top) * 100) : 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Card({ title, children, action, className }) {
  return (
    <section className={cn('rounded-xl border bg-card p-4', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-extrabold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
