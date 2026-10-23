import { useState } from 'react';

// Small hand-rolled SVG charts. Single-series: the card title names the series, so no legend.
// Marks are thin, data ends are rounded at 4px, lines are 2px, and every chart has hover
// tooltips plus a table view.

const INK = 'var(--text)';
const MUTED = '#6b6785';
const GRID = '#ece9f5';
const SERIES = '#7c3aed';
// One-hue sequential ramp (light → dark) for magnitude.
const RAMP = ['#f3eefe', '#e0d2fd', '#c4a8fb', '#a678f6', '#8b4cf0', '#6d28d9', '#4c1d95'];

const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
};
const shortDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function Tooltip({ tip }) {
  if (!tip) return null;
  return (
    <div style={{ position: 'absolute', left: tip.x, top: tip.y, transform: 'translate(-50%, calc(-100% - 10px))', background: INK, color: '#fff', padding: '6px 10px', borderRadius: 8, fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-lg)', zIndex: 5 }}>
      <div style={{ opacity: 0.7 }}>{tip.label}</div>
      <div style={{ fontWeight: 700 }}>{tip.value}</div>
    </div>
  );
}

/** Card with a chart and a "Table" toggle. rows: [[label, value], ...] */
export function ChartCard({ title, subtitle, rows, children, empty }) {
  const [table, setTable] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <div><h3>{title}</h3>{subtitle && <p className="tiny muted">{subtitle}</p>}</div>
        {rows?.length > 0 && <button className="btn ghost sm" onClick={() => setTable(!table)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>}
      </div>
      <div className="card-body">
        {empty ? <div className="empty" style={{ padding: 30 }}><h3 style={{ fontSize: 14 }}>{empty[0]}</h3><p className="small">{empty[1]}</p></div>
          : table ? (
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              <table className="table small"><tbody>{rows.map(([l, v]) => <tr key={l}><td>{l}</td><td style={{ textAlign: 'right' }}>{v}</td></tr>)}</tbody></table>
            </div>
          ) : children}
      </div>
    </div>
  );
}

/** Vertical bars over days. data: [{ day, value }] */
export function Bars({ data, height = 180, unit = '' }) {
  const [tip, setTip] = useState(null);
  const W = 640;
  const pad = { l: 30, r: 6, t: 8, b: 22 };
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const bw = (W - pad.l - pad.r) / data.length;
  const y = (v) => pad.t + (height - pad.t - pad.b) * (1 - v / max);
  const ticks = [...new Set([0, max / 2, max].map((t) => (max < 4 ? Math.round(t) : t)))];
  const every = Math.ceil(data.length / 6);
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Bar chart" onMouseLeave={() => setTip(null)}>
        {ticks.map((t) => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} /><text x={pad.l - 6} y={y(t) + 4} fontSize="10" fill={MUTED} textAnchor="end">{Math.round(t)}</text></g>)}
        {data.map((d, i) => {
          const x = pad.l + i * bw;
          const h = height - pad.b - y(d.value);
          const w = Math.max(2, bw - 2);
          return (
            <g key={d.day} onMouseEnter={(e) => setTip({ x: ((x + bw / 2) / W) * e.currentTarget.ownerSVGElement.clientWidth, y: (y(d.value) / height) * e.currentTarget.ownerSVGElement.clientHeight, label: shortDay(d.day), value: `${d.value}${unit}` })}>
              <rect x={x} y={pad.t} width={bw} height={height - pad.t - pad.b} fill="transparent" />
              {d.value > 0 && <path d={`M${x + 1},${height - pad.b} v${-Math.max(0, h - 4)} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${Math.max(0, h - 4)} z`} fill={SERIES} />}
              {i % every === 0 && <text x={x + bw / 2} y={height - 6} fontSize="10" fill={MUTED} textAnchor="middle">{shortDay(d.day)}</text>}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={height - pad.b} y2={height - pad.b} stroke="#d4d1e3" />
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Line over days with a hover crosshair. data: [{ day, value }] (null values are gaps). */
export function Line({ data, height = 180, format = (v) => v.toLocaleString() }) {
  const [hover, setHover] = useState(null);
  const W = 640;
  const pad = { l: 40, r: 10, t: 10, b: 22 };
  const vals = data.map((d) => d.value).filter((v) => v != null);
  const lo = Math.min(...vals, 0);
  const hi = niceMax(Math.max(...vals, 1));
  const x = (i) => pad.l + (i / Math.max(1, data.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (height - pad.t - pad.b) * (1 - (v - lo) / (hi - lo || 1));
  let path = '';
  data.forEach((d, i) => { if (d.value != null) path += `${path && data[i - 1]?.value != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`; });
  const every = Math.ceil(data.length / 6);
  const h = hover != null ? data[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Line chart"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(data.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (data.length - 1)))));
        }}
        onMouseLeave={() => setHover(null)}>
        {[lo, (lo + hi) / 2, hi].map((t) => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} /><text x={pad.l - 6} y={y(t) + 4} fontSize="10" fill={MUTED} textAnchor="end">{format(Math.round(t))}</text></g>)}
        {data.map((d, i) => i % every === 0 && <text key={d.day} x={x(i)} y={height - 6} fontSize="10" fill={MUTED} textAnchor="middle">{shortDay(d.day)}</text>)}
        <path d={path} fill="none" stroke={SERIES} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {h && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} stroke="#c4bfd9" strokeDasharray="3 3" />}
        {h?.value != null && <circle cx={x(hover)} cy={y(h.value)} r="5" fill={SERIES} stroke="#fff" strokeWidth="2" />}
      </svg>
      {h && <Tooltip tip={{ x: `${(x(hover) / W) * 100}%`, y: h.value != null ? `${(y(h.value) / height) * 100}%` : '50%', label: shortDay(h.day), value: h.value != null ? format(h.value) : 'No data' }} />}
    </div>
  );
}

/** Weekday × hour counts, one-hue sequential ramp. grid[7][24] */
export function Heatmap({ grid }) {
  const [tip, setTip] = useState(null);
  const max = Math.max(1, ...grid.flat());
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const color = (v) => (v ? RAMP[Math.min(RAMP.length - 1, 1 + Math.floor((v / max) * (RAMP.length - 2)))] : '#f5f4fa');
  return (
    <div style={{ position: 'relative' }} onMouseLeave={() => setTip(null)}>
      <div className="heat">
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="center">{h % 6 === 0 ? h : ''}</span>)}
        {grid.map((row, d) => [
          <span key={`l${d}`}>{DOW[d]}</span>,
          ...row.map((v, h) => (
            <div key={`${d}-${h}`} className="c" style={{ background: color(v) }}
              onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); const p = e.currentTarget.parentElement.getBoundingClientRect(); setTip({ x: r.left - p.left + r.width / 2, y: r.top - p.top, label: `${DOW[d]} ${String(h).padStart(2, '0')}:00`, value: `${v} post${v === 1 ? '' : 's'}` }); }} />
          )),
        ])}
      </div>
      <div className="row tiny muted" style={{ marginTop: 8, gap: 4 }}>Fewer {RAMP.slice(1).map((c) => <span key={c} style={{ width: 14, height: 10, background: c, borderRadius: 2 }} />)} More</div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Horizontal bars for a ranked breakdown. items: [{ label, value, icon }] */
export function HBars({ items, format = (v) => v.toLocaleString() }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  return (
    <div className="stack tight">
      {items.map((i) => (
        <div key={i.label} title={`${i.label}: ${format(i.value)} (${Math.round((i.value / total) * 100)}%)`}>
          <div className="row between small"><span>{i.icon} {i.label}</span><span className="muted">{format(i.value)} · {Math.round((i.value / total) * 100)}%</span></div>
          <div style={{ height: 8, background: '#f1eff8', borderRadius: 4, marginTop: 4 }}><div style={{ width: `${(i.value / max) * 100}%`, height: '100%', background: SERIES, borderRadius: 4 }} /></div>
        </div>
      ))}
    </div>
  );
}
