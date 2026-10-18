import { tx } from "../lib/i18n";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type ISeriesApi } from "lightweight-charts";
import { localTime } from "./Chart";
import { clock, dollars } from "../lib/format";

export const INK = "#0a1638";
export const GREEN = "#087f57";
export const RED = "#ce3045";
export const BLUE = "#1640ff";
export const GREY = "#4b5675";

const fade = (hex: string, alpha: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

// ---------------------------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------------------------

export interface Line {
  name: string;
  color: string;
  points: { t: number; v: number }[];
  /** Shade under the line. */
  area?: boolean;
}

export function Lines({ lines, format = dollars, labelColor = "#4b5675", labelSize = 11, lastValueVisible = lines.length <= 2 }: { lines: Line[]; format?: (value: number) => string; labelColor?: string; labelSize?: number; lastValueVisible?: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area">[]>([]);
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    const chart = createChart(holder.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#ffffff" }, textColor: labelColor, fontFamily: '"Archivo Variable", "Helvetica Neue", Arial, sans-serif', fontSize: labelSize, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "#eef1f7", style: LineStyle.Dashed } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.16, bottom: 0.1 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true, rightOffset: 2 },
      handleScroll: false,
      handleScale: false,
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: "#cdd4e3", labelBackgroundColor: "#0a1638" }, horzLine: { color: "#cdd4e3", labelBackgroundColor: "#0a1638" } },
      localization: { priceFormatter: (value: number) => formatRef.current(value) },
    });
    chartRef.current = chart;
    const timeScale = chart.timeScale();
    const fit = () => timeScale.fitContent();
    timeScale.subscribeSizeChange(fit);
    return () => {
      timeScale.unsubscribeSizeChange(fit);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({ layout: { textColor: labelColor, fontSize: labelSize } });
  }, [labelColor, labelSize]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    while (seriesRef.current.length > lines.length) chart.removeSeries(seriesRef.current.pop()!);
    lines.forEach((line, i) => {
      const series = (seriesRef.current[i] ??= chart.addAreaSeries({ lineWidth: 2, priceLineVisible: false, crosshairMarkerRadius: 3 }));
      series.applyOptions({
        lastValueVisible,
        lineColor: line.color,
        topColor: line.area ? fade(line.color, 0.16) : "rgba(0, 0, 0, 0)",
        bottomColor: line.area ? fade(line.color, 0.02) : "rgba(0, 0, 0, 0)",
      });
      // One point per timestamp, in order: the library insists.
      const seen = new Map<number, number>();
      for (const point of line.points) if (Number.isFinite(point.v)) seen.set(localTime(point.t), point.v);
      series.setData([...seen].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as never, value })));
    });
    chart.timeScale().fitContent();
  }, [lines, lastValueVisible]);

  const empty = lines.every((line) => line.points.length < 2);
  return (
    <div className="plot">
      <div className="plot" ref={holder} />
      {empty && (<div className="plot empty" style={{ pointerEvents: "none" }}>{tx("Collecting data. This fills in as the exchange runs.")}</div>)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// SVG plots
// ---------------------------------------------------------------------------------------------

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setSize((prev) => (prev.w === el.clientWidth && prev.h === el.clientHeight ? prev : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

export function Plot({ label, children }: { label: string; children: (w: number, h: number) => ReactNode }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  return (
    <div className="plot" ref={ref}>
      {w > 40 && h > 40 && (<svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={tx(label)}>
          {children(w, h)}
        </svg>)}
    </div>
  );
}

/** A round number at or above `value`, for the top of an axis. */
function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const lead = value / power;
  return (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 5 ? 5 : 10) * power;
}

export function Bars({ bars, format = dollars }: { bars: { t: number; v: number }[]; format?: (value: number) => string }) {
  return (
    <Plot label={tx("Bar chart")}>
      {(w, h) => {
        const right = 60;
        const bottom = 22;
        const top = 12;
        const max = niceCeil(Math.max(...bars.map((b) => b.v), 0));
        const innerW = w - right;
        const innerH = h - bottom - top;
        const slot = innerW / Math.max(bars.length, 1);
        const barW = Math.max(1, Math.min(18, slot * 0.72));
        // First, middle and last; with one or two bars those coincide.
        const labels = bars.length ? [...new Set([0, Math.floor(bars.length / 2), bars.length - 1])] : [];
        return (
          <>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line x1={0} x2={innerW} y1={top + innerH * (1 - f)} y2={top + innerH * (1 - f)} stroke="#eef1f7" strokeDasharray="3 3" />
                <text x={innerW + 8} y={top + innerH * (1 - f) + 3}>
                  {format(max * f)}
                </text>
              </g>
            ))}
            {bars.map((bar, i) => {
              const height = max > 0 ? (bar.v / max) * innerH : 0;
              return <rect key={bar.t} x={i * slot + (slot - barW) / 2} y={top + innerH - height} width={barW} height={Math.max(height, bar.v > 0 ? 1 : 0)} fill={GREEN} />;
            })}
            {labels.map((i) => (
              <text key={i} x={Math.min(Math.max(i * slot + slot / 2, 16), innerW - 16)} y={h - 6} textAnchor="middle">
                {clock(bars[i].t)}
              </text>
            ))}
          </>
        );
      }}
    </Plot>
  );
}

/** Coin paid per dollar lost, against everything lost so far. Only ever falls. */
export function RewardCurve({ perDollar, lossNow, scale, symbol }: { perDollar: number; lossNow: number; scale: number; symbol: string }) {
  return (
    <Plot label={tx("Reward curve")}>
      {(w, h) => {
        const left = 44;
        const right = 16;
        const top = 22;
        const bottom = 26;
        const xMax = Math.max(scale * 4, lossNow * 1.5);
        const rate = (loss: number) => perDollar * ((scale + lossNow) / (scale + loss)) ** 2;
        const yMax = rate(0) * 1.08 || 1;
        const x = (loss: number) => left + (loss / xMax) * (w - left - right);
        const y = (value: number) => top + (1 - value / yMax) * (h - top - bottom);
        const steps = 80;
        const path = Array.from({ length: steps + 1 }, (_, i) => {
          const loss = (xMax * i) / steps;
          return `${i ? "L" : "M"}${x(loss).toFixed(1)},${y(rate(loss)).toFixed(1)}`;
        }).join("");
        const tagX = Math.min(x(lossNow) + 8, w - 150);
        return (
          <>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line x1={left} x2={w - right} y1={y(rate(0) * f)} y2={y(rate(0) * f)} stroke="#eef1f7" strokeDasharray="3 3" />
                <text x={left - 8} y={y(rate(0) * f) + 3} textAnchor="end">
                  {(rate(0) * f).toFixed(rate(0) >= 20 ? 0 : 1)}
                </text>
              </g>
            ))}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <text key={f} x={x(xMax * f)} y={h - 8} textAnchor={f === 1 ? "end" : f === 0 ? "start" : "middle"}>
                {dollars(xMax * f)}
              </text>
            ))}
            <path d={`${path}L${x(xMax)},${y(0)}L${x(0)},${y(0)}Z`} fill={fade(BLUE, 0.08)} />
            <path d={path} fill="none" stroke={BLUE} strokeWidth={2} />
            <line x1={x(scale)} x2={x(scale)} y1={top} y2={y(0)} stroke={GREY} strokeDasharray="3 4" />
            <text x={x(scale) + 6} y={top + 10} style={{ fill: GREY, fontWeight: 600 }}>
              {tx(" Half mined at ")}{dollars(scale)}
            </text>
            <line x1={x(lossNow)} x2={x(lossNow)} y1={top} y2={y(0)} stroke={GREEN} strokeDasharray="2 3" />
            <circle cx={x(lossNow)} cy={y(perDollar)} r={4} fill={GREEN} />
            <text x={tagX} y={y(perDollar) - 9} style={{ fill: GREEN, fontWeight: 600, fontSize: 11 }}>
              {perDollar.toFixed(perDollar >= 20 ? 1 : 2)} {symbol} / $1 · {dollars(lossNow)} {tx(" lost so far ")}</text>
            <text x={left} y={12} style={{ fill: BLUE, fontWeight: 600 }}>
              {symbol} {tx(" per $1 lost ")}</text>
          </>
        );
      }}
    </Plot>
  );
}

/** What the house makes or loses if the price moves, from -range to +range. */
export function PnlCurve({ points, range, priceLabel }: { points: { x: number; v: number }[]; range: number; priceLabel: string }) {
  return (
    <Plot label={tx("Vault profit and loss by price move")}>
      {(w, h) => {
        if (points.length < 2) return null;
        const top = 26;
        const bottom = 26;
        const hi = Math.max(...points.map((p) => p.v), 0);
        const lo = Math.min(...points.map((p) => p.v), 0);
        const span = hi - lo || 1;
        const x = (move: number) => ((move + range) / (2 * range)) * w;
        const y = (value: number) => top + ((hi - value) / span) * (h - top - bottom);
        const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
        const now = points.reduce((best, p) => (Math.abs(p.x) < Math.abs(best.x) ? p : best), points[0]);
        return (
          <>
            <path d={`${path}L${w},${y(0)}L0,${y(0)}Z`} fill={fade(INK, 0.07)} />
            <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="#cdd4e3" />
            <path d={path} fill="none" stroke={INK} strokeWidth={1.6} />
            <line x1={x(0)} x2={x(0)} y1={top - 6} y2={h - bottom} stroke={GREY} />
            <circle cx={x(now.x)} cy={y(now.v)} r={3.5} fill={now.v >= 0 ? GREEN : RED} />
            <text x={0} y={14} style={{ fill: GREEN }}>
              {hi > 0 ? "+" : ""}
              {dollars(hi)}
            </text>
            <text x={0} y={h - bottom + 2} style={{ fill: RED }}>
              {dollars(lo)}
            </text>
            <text x={x(0) + 7} y={14} style={{ fill: now.v >= 0 ? GREEN : RED, fontWeight: 600 }}>
              {tx(" now ")}{now.v > 0 ? "+" : ""}
              {dollars(now.v)}
            </text>
            <text x={0} y={h - 6}>
              -{(range * 100).toFixed(0)}%
            </text>
            <text x={w / 2} y={h - 6} textAnchor="middle">
              {priceLabel}
            </text>
            <text x={w} y={h - 6} textAnchor="end">
              +{(range * 100).toFixed(0)}%
            </text>
          </>
        );
      }}
    </Plot>
  );
}

/**
 * Where positions would bust, as bands of notional by price, with the recent price drawn over it.
 * `bins[0]` is the band at the top of the range.
 */
export function Heatmap({ bins, top, bottom, path, last }: { bins: number[]; top: number; bottom: number; path: { t: number; p: number }[]; last: number }) {
  return (
    <Plot label={tx("Liquidation map")}>
      {(w, h) => {
        const right = 66;
        const foot = 20;
        const innerW = w - right;
        const innerH = h - foot;
        const rowH = innerH / bins.length;
        const max = Math.max(...bins, 0);
        const y = (price: number) => ((top - price) / (top - bottom)) * innerH;
        const t0 = path[0]?.t ?? 0;
        const t1 = path[path.length - 1]?.t ?? 1;
        // The line stops short of the edge: the space to its right is "not yet".
        const x = (t: number) => ((t - t0) / Math.max(t1 - t0, 1)) * innerW * 0.93;
        const line = path
          .filter((p) => p.p <= top && p.p >= bottom)
          .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`)
          .join("");
        return (
          <>
            {bins.map((value, i) => {
              if (value <= 0 || max <= 0) return null;
              const strength = Math.sqrt(value / max);
              const fill = strength > 0.62 ? fade(BLUE, 0.2 + 0.6 * strength) : fade(GREEN, 0.08 + 0.5 * strength);
              return <rect key={i} x={0} y={i * rowH} width={innerW} height={rowH + 0.5} fill={fill} />;
            })}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const price = top - (top - bottom) * f;
              return (
                <text key={f} x={innerW + 8} y={Math.min(Math.max(y(price) + 3, 10), innerH - 2)}>
                  {price.toLocaleString("en-US", { maximumFractionDigits: price >= 1000 ? 1 : 2 })}
                </text>
              );
            })}
            {line && <path d={line} fill="none" stroke={INK} strokeWidth={1.6} />}
            {last > 0 && last <= top && last >= bottom && (
              <>
                <line x1={0} x2={innerW} y1={y(last)} y2={y(last)} stroke={BLUE} strokeDasharray="2 3" />
                <rect x={innerW + 2} y={y(last) - 9} width={right - 4} height={18} fill={BLUE} />
                <text x={innerW + 7} y={y(last) + 3.5} style={{ fill: "#fff", fontWeight: 600 }}>
                  {last.toLocaleString("en-US", { maximumFractionDigits: last >= 1000 ? 1 : 2 })}
                </text>
              </>
            )}
            {path.length > 1 && (
              <>
                <text x={0} y={h - 5}>
                  {clock(t0)}
                </text>
                <text x={innerW * 0.93} y={h - 5} textAnchor="end">
                  {clock(t1)}
                </text>
              </>
            )}
          </>
        );
      }}
    </Plot>
  );
}

/**
 * Every open position as a dot. Across: short to long, further out is more leverage. Up and down:
 * how much the house is winning or losing on it right now, on a log scale.
 */
export function Topology({ dots }: { dots: { x: number; y: number; r: number }[] }) {
  return (
    <Plot label={tx("Position map")}>
      {(w, h) => {
        const pad = 22;
        const cx = w / 2;
        const cy = h / 2;
        const sx = cx - pad;
        const sy = cy - pad;
        return (
          <>
            <line x1={pad} x2={w - pad} y1={cy} y2={cy} stroke="#cdd4e3" />
            <line x1={cx} x2={cx} y1={pad} y2={h - pad} stroke="#cdd4e3" />
            {[1, 2, 3].map((n) => (
              <g key={n}>
                <line x1={cx - 3} x2={cx + 3} y1={cy - (sy * n) / 4} y2={cy - (sy * n) / 4} stroke="#555" />
                <line x1={cx - 3} x2={cx + 3} y1={cy + (sy * n) / 4} y2={cy + (sy * n) / 4} stroke="#555" />
                <text x={cx + 8} y={cy - (sy * n) / 4 + 3}>
                  +{dollars(10 ** n)}
                </text>
                <text x={cx + 8} y={cy + (sy * n) / 4 + 3}>
                  -{dollars(10 ** n)}
                </text>
              </g>
            ))}
            {dots.map((dot, i) => (
              <circle key={i} cx={cx + dot.x * sx} cy={cy - dot.y * sy} r={dot.r} fill={dot.y >= 0 ? fade(GREEN, 0.34) : fade(RED, 0.34)} />
            ))}
            <text x={pad} y={cy - 6} style={{ fontWeight: 600 }}>
              {tx(" Short 1000x ")}</text>
            <text x={w - pad} y={cy - 6} textAnchor="end" style={{ fontWeight: 600 }}>
              {tx(" Long 1000x ")}</text>
            <text x={cx + 8} y={pad - 6} style={{ fontWeight: 600 }}>
              {tx(" Vault up ")}</text>
            <text x={cx + 8} y={h - pad + 14} style={{ fontWeight: 600 }}>
              {tx(" Vault down ")}</text>
          </>
        );
      }}
    </Plot>
  );
}

/** The queue as a ring: what is ahead of you, yours, and what is behind. */
export function QueueRing({ ahead, mine, behind, caption }: { ahead: number; mine: number; behind: number; caption: string }) {
  return (
    <Plot label={tx("Queue placement")}>
      {(w, h) => {
        const size = Math.min(w, h - 26);
        const r = size / 2 - 22;
        const cx = w / 2;
        const cy = (h - 26) / 2 + 4;
        const total = ahead + mine + behind;
        const circumference = 2 * Math.PI * r;
        let offset = 0;
        const arc = (value: number, color: string) => {
          if (value <= 0 || total <= 0) return null;
          const length = (value / total) * circumference;
          const el = (
            <circle
              key={color}
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={22}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
          offset += length;
          return el;
        };
        return (
          <>
            <defs>
              <pattern id="ring-empty" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="4" height="8" fill="#eef1f7" />
              </pattern>
            </defs>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={total > 0 ? "#eef1f7" : "url(#ring-empty)"} strokeWidth={22} />
            {arc(ahead, "#8a93ab")}
            {arc(mine, BLUE)}
            {arc(behind, "#cdd4e3")}
            <text x={cx} y={cy + 4} textAnchor="middle" style={{ fill: total > 0 ? INK : GREY, fontSize: 12, fontWeight: 600 }}>
              {total > 0 ? dollars(total) : tx("Queue empty")}
            </text>
            <text x={cx} y={h - 8} textAnchor="middle">
              {caption}
            </text>
          </>
        );
      }}
    </Plot>
  );
}
