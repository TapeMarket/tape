import { tx, useLocale } from "../lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { ColorType, CrosshairMode, LastPriceAnimationMode, LineStyle, LineType, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { bustPrice } from "@shared/math.mjs";
import { loadPrices, onTick } from "../lib/api";
import { heldCandles, loadCandles, type Bar } from "../lib/candles";
import { coinOf } from "../lib/hl";
import { getState, useStore } from "../lib/store";
import { priceNumber } from "../lib/format";
import type { Position } from "../lib/types";

// A bust line is kept on screen only while doing so leaves the price action readable: it must be
// within a few multiples of the range the chart is already showing (or within a handful of basis
// points, so a fresh 1000x position always shows its line). Further away, fitting it would squash
// the chart flat, so it is left off the scale.
/** The most points the price line holds: an hour of one-second prints. */
const KEEP_POINTS = 3_600;
/** The stepped line keeps its wider view; Tick opens on roughly the last 90 seconds. */
const OPEN_ON_POINTS = 480;
const OPEN_ON_TICKS = 90;
const KEEP_RANGES = 2.5;
const KEEP_ALWAYS = 0.0009;

/** A stretch of hazard tape over the chart, in pixels. */
interface Box {
  top: number;
  height: number;
  below: boolean;
  live: boolean;
}

interface Zone {
  /** Bust price as a number. */
  price: number;
  /** True for the lower zone (a long busts by falling), false for the upper one. */
  below: boolean;
  /** A real position's bust, as opposed to the ticket's preview. */
  live: boolean;
}

function zonesFor(positions: Position[], marketId: number, preview: Zone | null): Zone[] {
  let lower: Zone | null = null;
  let upper: Zone | null = null;
  for (const p of positions) {
    if (p.market !== marketId) continue;
    const value = priceNumber(p.bust);
    if (p.isLong && (!lower || value > lower.price)) lower = { price: value, below: true, live: true };
    if (!p.isLong && (!upper || value < upper.price)) upper = { price: value, below: false, live: true };
  }
  // The preview only shows on the side where no real position already marks a bust.
  if (preview?.below && !lower) lower = preview;
  if (preview && !preview.below && !upper) upper = preview;
  return [lower, upper].filter((z): z is Zone => z !== null);
}

/** Charts read in the viewer's own time zone; the library only knows UTC. */
export const localTime = (unixSeconds: number): UTCTimestamp => (unixSeconds - new Date(unixSeconds * 1000).getTimezoneOffset() * 60) as UTCTimestamp;

/**
 * The price chart. `interval` is the width of one step in seconds; 0 draws every print.
 */
/** From this step up the chart draws candles, with history; below it, the line of live prints. */
const CANDLES_FROM = 60;

export function Chart({ marketId, interval = 0 }: { marketId: number; interval?: number }) {
  const locale = useLocale();
  const holder = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const previewRef = useRef<IPriceLine | null>(null);
  const zonesRef = useRef<Zone[]>([]);
  const lastRef = useRef<number>(0);
  const resetViewRef = useRef<(() => void) | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);

  const positions = useStore((s) => s.account?.positions) ?? EMPTY;
  const ticket = useStore((s) => s.ticket);
  const tick = useStore((s) => s.ticks[marketId]);
  const market = useStore((s) => s.config?.markets[marketId]);

  // Where the hazard tape goes, in pixels. Recomputed whenever the scale can have moved.
  const layout = useRef(() => {});
  const layoutFrame = useRef<number | null>(null);
  // A tick, a scale change and the ticket preview can arrive in the same frame. Measure once.
  const scheduleLayout = useCallback(() => {
    if (layoutFrame.current !== null) return;
    layoutFrame.current = requestAnimationFrame(() => {
      layoutFrame.current = null;
      layout.current();
    });
  }, []);
  layout.current = () => {
    const series = seriesRef.current;
    const el = holder.current;
    if (!series || !el) return;
    const height = el.clientHeight;
    const next: Box[] = [];
    for (const zone of zonesRef.current) {
      // On candles a 1000x bust sits a hair under the price while the scale spans days of
      // movement: the tape for an order not even placed would blanket half the chart. Its line
      // stays; only positions actually open get the tape.
      if (!zone.live && interval >= CANDLES_FROM) continue;
      const y = series.priceToCoordinate(zone.price);
      if (y === null) continue;
      const top = zone.below ? Math.max(0, y) : 0;
      const bottom = zone.below ? height : Math.min(height, y);
      if (bottom - top > 1) next.push({ top, height: bottom - top, below: zone.below, live: zone.live });
    }
    setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
  };

  // Create the chart once.
  useEffect(() => {
    const el = holder.current!;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "rgba(0, 0, 0, 0)" },
        textColor: "#8a93ab",
        fontFamily: '"Archivo Variable", "Helvetica Neue", Arial, sans-serif',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "#eef1f7", style: LineStyle.Dashed } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.2, bottom: 0.14 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: interval < CANDLES_FROM,
        rightOffset: interval < CANDLES_FROM ? 14 : 6,
        barSpacing: interval < CANDLES_FROM ? 5 : 7,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#cdd4e3", labelBackgroundColor: "#0a1638" },
        horzLine: { color: "#cdd4e3", labelBackgroundColor: "#0a1638" },
      },
    });
    const shared = {
      priceLineColor: "#1640ff",
      priceFormat: { type: "price" as const, precision: 2, minMove: 0.01 },
      // Keep nearby entry and bust lines inside the visible price range.
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const info = original();
        if (!info) return info;
        const last = lastRef.current;
        let { minValue, maxValue } = info.priceRange;
        const reach = Math.max((maxValue - minValue) * KEEP_RANGES, last * KEEP_ALWAYS);
        for (const zone of zonesRef.current) {
          if (!last || Math.abs(zone.price - last) > reach) continue;
          minValue = Math.min(minValue, zone.price);
          maxValue = Math.max(maxValue, zone.price);
        }
        return { ...info, priceRange: { minValue, maxValue } };
      },
    };
    const series =
      interval >= CANDLES_FROM
        ? chart.addCandlestickSeries({ upColor: "#0b9e6b", downColor: "#e23d52", wickUpColor: "#0b9e6b", wickDownColor: "#e23d52", borderVisible: false, ...shared })
        : chart.addAreaSeries({
            lineColor: "#1640ff",
            lineWidth: 2,
            lineType: LineType.Simple,
            lastPriceAnimation: matchMedia("(prefers-reduced-motion: reduce)").matches ? LastPriceAnimationMode.Disabled : LastPriceAnimationMode.OnDataUpdate,
            topColor: "rgba(22, 64, 255, 0.14)",
            bottomColor: "rgba(22, 64, 255, 0.01)",
            ...shared,
          });
    chartRef.current = chart;
    seriesRef.current = series;

    const relayout = scheduleLayout;
    chart.timeScale().subscribeVisibleLogicalRangeChange(relayout);
    const observer = new ResizeObserver(relayout);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current);
      layoutFrame.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
      previewRef.current = null;
    };
  }, []);

  // Candles: history from the market's public record, the candle in progress from live prices,
  // and older history fetched as the chart is scrolled back.
  useEffect(() => {
    const series = seriesRef.current as ISeriesApi<"Candlestick"> | null;
    const chart = chartRef.current;
    if (!series || !chart || interval < CANDLES_FROM) return;
    const symbol = market ? coinOf(market) : "BTC";
    let alive = true;
    let bars: Bar[] = [];
    let noHistory = false;
    let fetchingOlder = false;
    let reachedTheStart = false;
    const shown = (bar: Bar) => ({ time: localTime(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    const draw = () => series.setData(bars.map(shown));

    const onPrice = (t: number, p: bigint) => {
      if (!alive) return;
      const value = priceNumber(p);
      lastRef.current = value;
      const bucket = Math.floor(t / interval) * interval;
      const last = bars[bars.length - 1];
      if (!last) {
        // With no history to stand on (the record could not be fetched), start from this print.
        if (!noHistory) return;
        bars.push({ time: bucket, open: value, high: value, low: value, close: value });
      } else if (bucket < last.time) return;
      else if (bucket === last.time) {
        last.close = value;
        if (value > last.high) last.high = value;
        if (value < last.low) last.low = value;
      } else bars.push({ time: bucket, open: last.close, high: Math.max(last.close, value), low: Math.min(last.close, value), close: value });
      series.update(shown(bars[bars.length - 1]));
      scheduleLayout();
    };
    const catchUp = () => {
      const latest = getState().ticks[marketId];
      if (latest) onPrice(latest.t, latest.p);
    };

    // What was fetched before is drawn at once; the fresh copy replaces it when it arrives.
    bars = heldCandles(symbol, interval);
    draw();
    if (bars.length) {
      catchUp();
      chart.timeScale().scrollToRealTime();
    }
    loadCandles(symbol, interval)
      .then((latest) => {
        if (!alive || latest.length === 0) return;
        const first = bars.length === 0;
        // Keep whatever older pages have been added in the meantime.
        bars = [...bars.filter((bar) => bar.time < latest[0].time), ...latest];
        draw();
        catchUp();
        if (first) chart.timeScale().scrollToRealTime();
      })
      .catch(() => {
        if (!alive) return;
        noHistory = true;
        catchUp();
      });

    const older = (range: { from: number; to: number } | null) => {
      if (!range || range.from > 40 || fetchingOlder || reachedTheStart || bars.length === 0) return;
      fetchingOlder = true;
      loadCandles(symbol, interval, bars[0].time)
        .then((page) => {
          if (!alive) return;
          if (page.length === 0) {
            reachedTheStart = true;
            return;
          }
          // Adding bars on the left renumbers them all: put the view back on the same stretch of time.
          const view = chart.timeScale().getVisibleRange();
          bars = [...page, ...bars];
          draw();
          if (view) chart.timeScale().setVisibleRange(view);
        })
        .catch(() => {})
        .finally(() => {
          fetchingOlder = false;
        });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(older);
    const off = onTick((m, t) => {
      if (m === marketId) onPrice(t.t, t.p);
    });
    return () => {
      alive = false;
      off();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(older);
    };
  }, [marketId, interval]);

  // The line: the market's minute closes for as far back as the chart is scrolled, then the
  // exchange's own prints of the last hour, then every tick as it comes.
  useEffect(() => {
    const series = seriesRef.current as ISeriesApi<"Area"> | null;
    const chart = chartRef.current;
    if (!series || !chart || interval >= CANDLES_FROM) return;
    const coin = market ? coinOf(market) : "BTC";
    let alive = true;
    let lastTime = 0;
    series.setData([]);
    lastRef.current = 0;
    type Point = { time: UTCTimestamp; value: number };

    // With an interval, every print in the same step redraws that step's one point.
    const step = (t: number) => (interval > 0 ? Math.floor(t / interval) * interval : t);
    /** Minute closes, oldest first, from the market's public record. */
    let history: Bar[] = [];
    /** The exchange's prints, stepped. Trimmed when a tab has been open for days. */
    let live: Point[] = [];
    let fetchingOlder = false;
    let reachedTheStart = false;
    let pointCount = 0;
    let touched = false;
    let motionFrame: number | null = null;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const stopMotion = () => {
      if (motionFrame !== null) cancelAnimationFrame(motionFrame);
      motionFrame = null;
    };
    const all = (): Point[] => {
      const latest = getState().ticks[marketId];
      const from = live.length ? live[0].time : localTime(step(latest?.t ?? Math.floor(Date.now() / 1000)));
      // Only finished minutes have a close. The current candle's nominal end is in the future:
      // drawing it before the first live tick would make series.update go backwards in time.
      const closes = history.map((bar) => ({ time: localTime(bar.time + 59), value: bar.close })).filter((pt) => pt.time < from);
      return [...closes, ...live];
    };
    const redraw = () => {
      stopMotion();
      const points = all();
      pointCount = points.length;
      series.setData(points);
    };

    const push = (t: number, p: bigint) => {
      if (!alive) return;
      if (step(t) < lastTime) return;
      lastTime = step(t);
      lastRef.current = priceNumber(p);
      const point = { time: localTime(lastTime), value: lastRef.current };
      const appended = !live.length || live[live.length - 1].time !== point.time;
      const scale = chart.timeScale();
      const view = appended && !touched ? scale.getVisibleLogicalRange() : null;
      const follow = interval === 0 && view && pointCount > 0 && view.to >= pointCount - 1;
      if (!appended) live[live.length - 1] = point;
      else { live.push(point); pointCount++; }
      if (live.length > KEEP_POINTS * 1.5) {
        live = live.slice(-KEEP_POINTS);
        redraw();
      } else {
        // Prices update immediately and exactly. Only the viewport moves between frames.
        series.update(point);
        if (follow && !reducedMotion.matches && !document.hidden) {
          stopMotion();
          const target = scale.getVisibleLogicalRange();
          if (target) {
            scale.setVisibleLogicalRange(view);
            const started = performance.now();
            const move = (now: number) => {
              const progress = Math.min(1, (now - started) / 160);
              const eased = 1 - Math.pow(1 - progress, 3);
              scale.setVisibleLogicalRange({ from: view.from + (target.from - view.from) * eased, to: view.to + (target.to - view.to) * eased });
              scheduleLayout();
              motionFrame = progress < 1 && !document.hidden ? requestAnimationFrame(move) : null;
            };
            motionFrame = requestAnimationFrame(move);
          }
        }
      }
      scheduleLayout();
    };

    // The view follows the latest stretch as data arrives, until the reader scrolls or zooms it.
    const touch = () => { touched = true; stopMotion(); };
    const box = holder.current;
    box?.addEventListener("wheel", touch, { passive: true });
    box?.addEventListener("pointerdown", touch);
    const open = () => {
      const scale = chart.timeScale();
      const count = all().length;
      const window = interval === 0 ? OPEN_ON_TICKS : OPEN_ON_POINTS;
      if (count > window) scale.setVisibleLogicalRange({ from: count - window, to: count + 14 });
      else scale.fitContent();
    };
    resetViewRef.current = () => { touched = false; stopMotion(); open(); };

    // Whatever arrives is drawn as it arrives; any minute closes fetched on an earlier visit or
    // while hovering this market appear immediately, without waiting for another request.
    const refresh = () => {
      if (!alive) return;
      const view = touched ? chart.timeScale().getVisibleRange() : null;
      redraw();
      const latest = getState().ticks[marketId];
      if (latest) push(latest.t, latest.p);
      if (view) chart.timeScale().setVisibleRange(view);
      else if (all().length) open();
    };
    history = heldCandles(coin, 60);
    refresh();
    // The last hour, where there is that much: the exchange keeps the recent prints itself.
    loadPrices(marketId, 3600)
      .then(({ points }) => {
        if (!alive) return;
        const stepped = new Map<number, number>();
        for (const pt of points) stepped.set(step(pt.t), priceNumber(pt.p));
        const fetched = [...stepped].sort(([a], [b]) => a - b).map(([t, value]) => ({ time: localTime(t), value }));
        // Ticks that came in while it was on its way stay.
        live = [...fetched, ...live.filter((pt) => !fetched.length || pt.time > fetched[fetched.length - 1].time)];
        if (points.length) lastTime = Math.max(lastTime, step(points[points.length - 1].t));
        refresh();
      })
      .catch(() => {});
    // Before that, the last five hours of minute closes.
    loadCandles(coin, 60)
      .then((latest) => {
        if (!alive || latest.length === 0) return;
        history = [...history.filter((bar) => bar.time < latest[0].time), ...latest];
        refresh();
      })
      .catch(() => {});

    // Scrolled back to the start of what is drawn: the five hours before it.
    const older = (range: { from: number; to: number } | null) => {
      if (!range || range.from > 40 || fetchingOlder || reachedTheStart || history.length === 0) return;
      fetchingOlder = true;
      loadCandles(coin, 60, history[0].time)
        .then((page) => {
          if (!alive) return;
          if (page.length === 0) {
            reachedTheStart = true;
            return;
          }
          const view = chart.timeScale().getVisibleRange();
          history = [...page, ...history];
          redraw();
          if (view) chart.timeScale().setVisibleRange(view);
        })
        .catch(() => {})
        .finally(() => {
          fetchingOlder = false;
        });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(older);

    const off = onTick((m, t) => {
      if (m === marketId) push(t.t, t.p);
    });
    return () => {
      alive = false;
      stopMotion();
      resetViewRef.current = null;
      off();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(older);
      box?.removeEventListener("wheel", touch);
      box?.removeEventListener("pointerdown", touch);
    };
  }, [marketId, interval]);

  // Entry and bust lines for open positions.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = [];
    for (const p of positions) {
      if (p.market !== marketId) continue;
      linesRef.current.push(
        series.createPriceLine({
          price: priceNumber(p.entryPrice),
          color: p.isLong ? "#0b9e6b" : "#e23d52",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${tx(p.isLong ? "long" : "short")} ${p.leverage}x`,
        }),
        series.createPriceLine({
          price: priceNumber(p.bust),
          color: "#e23d52",
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: tx("liq."),
        }),
      );
      for (const [at, title, color] of [
        [p.takeProfit, "TP", "#0b9e6b"],
        [p.stopLoss, "SL", "#e23d52"],
      ] as const) {
        if (!at) continue;
        linesRef.current.push(
          series.createPriceLine({
            price: priceNumber(at),
            color,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title,
          }),
        );
      }
    }
  }, [positions, marketId, locale]);

  // The ticket's preview: where a position opened right now would bust. It follows the mark, so
  // the one line is moved on each tick rather than rebuilt.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const preview: Zone | null =
      tick && market && ticket.leverage >= 1
        ? { price: priceNumber(bustPrice(tick.p, ticket.leverage, ticket.isLong, market)), below: ticket.isLong, live: false }
        : null;
    zonesRef.current = zonesFor(positions, marketId, preview);

    const shown = zonesRef.current.find((zone) => !zone.live) ?? null;
    if (shown && previewRef.current) previewRef.current.applyOptions({ price: shown.price, title: tx("liq. if opened now") });
    else if (shown) {
      previewRef.current = series.createPriceLine({
        price: shown.price,
        color: "#ef8593",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: tx("liq. if opened now"),
      });
    } else if (previewRef.current) {
      series.removePriceLine(previewRef.current);
      previewRef.current = null;
    }
    scheduleLayout();
  }, [positions, marketId, ticket, tick, market, locale]);

  return (
    <div className="chart">
      <div className="chart-canvas" ref={holder} />
      <button
        className="chip chart-reset"
        title={tx("Back to the live price at the normal zoom")}
        onClick={() => {
          const chart = chartRef.current;
          if (!chart) return;
          if (resetViewRef.current) resetViewRef.current();
          else {
            chart.timeScale().resetTimeScale();
            chart.timeScale().scrollToRealTime();
          }
          chart.priceScale("right").applyOptions({ autoScale: true });
        }}
      >{tx("Reset")}</button>
      {boxes.map((box, i) => (
        <div
          key={i}
          className={`bust-zone ${box.below ? "below" : "above"} ${box.live ? "" : "preview"}`}
          data-label={box.live ? tx("Liquidation") : ""}
          style={{ top: box.top, height: box.height }}
        />
      ))}
    </div>
  );
}

const EMPTY: Position[] = [];

function sameBoxes(a: Box[], b: Box[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((box, i) => Math.abs(box.top - b[i].top) < 0.5 && Math.abs(box.height - b[i].height) < 0.5 && box.below === b[i].below && box.live === b[i].live);
}
