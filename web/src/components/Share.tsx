import { useEffect, useRef, useState } from "react";
import { big, duration, price, usd } from "../lib/format";
import { BRAND } from "../lib/mode";
import { setState, toast, useStore } from "../lib/store";
import { Dialog } from "./Shell";
import { BRAND_ACCENT, WORDMARK_PATH, WORDMARK_SIZE } from "./Wordmark";

/** One trade, as a card to post: an open position at its mark, or a closed trade at its exit. */
export interface ShareData {
  symbol: string;
  isLong: boolean;
  leverage: number;
  /** 1e8 prices. */
  entry: bigint;
  exit: bigint;
  /** 6-decimal USDC. */
  pnl: bigint;
  margin: bigint;
  liquidated: boolean;
  open: boolean;
  /** Seconds the position was (or has been) open. */
  held: number;
  time: number;
}

/** Opens the share dialog for a trade. */
export function share(data: ShareData) {
  setState({ share: data, dialog: "share" });
}

const W = 1200;
const H = 675;
const FACE = '"Archivo Variable", "Helvetica Neue", Arial, sans-serif';
const NAVY = "#0a1638";
const GREEN = "#0b9e6b";
const RED = "#e23d52";

const roiOf = (d: ShareData) => (d.margin > 0n ? Number(d.pnl) / Number(d.margin) : 0);

function roiText(roi: number): string {
  const pct = roi * 100;
  const digits = Math.abs(pct) >= 1000 ? 0 : 1;
  const body = Math.abs(pct).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${body}%`;
}

/** What the post says, in words. */
function postText(d: ShareData): string {
  const what = `a ${d.leverage}x ${d.symbol} ${d.isLong ? "long" : "short"}`;
  if (d.liquidated) return `Liquidated on ${what} on ${BRAND}.`;
  const roi = roiText(roiOf(d));
  return d.open ? `${roi} so far on ${what} on ${BRAND}.` : `${roi} on ${what} on ${BRAND}.`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** The largest size, up to `max`, at which `text` fits in `width`. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: number, max: number, width: number): number {
  let size = max;
  for (; size > 40; size -= 4) {
    ctx.font = `${weight} ${size}px ${FACE}`;
    if (ctx.measureText(text).width <= width) break;
  }
  return size;
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, mid: number, fill: string, ink: string): number {
  ctx.font = `600 26px ${FACE}`;
  const w = ctx.measureText(text).width + 32;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, mid - 22, w, 44, 10);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 16, mid + 1);
  ctx.textBaseline = "alphabetic";
  return x + w;
}

/** Draws the card at 2x into `canvas`. */
export async function drawCard(canvas: HTMLCanvasElement, d: ShareData, link: string) {
  canvas.width = W * 2;
  canvas.height = H * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  await Promise.all([800, 600, 500].map((w) => document.fonts.load(`${w} 40px ${FACE}`))).catch(() => {});
  const icon = await loadImage(`/img/${d.symbol.toLowerCase()}.png`).catch(() => null);
  ctx.setTransform(2, 0, 0, 2, 0, 0);
  ctx.textAlign = "left";

  ctx.fillStyle = BRAND_ACCENT;
  ctx.fillRect(0, 0, W, H);

  // The wordmark, white, with its letters punched through to the blue.
  const [mw, mh] = WORDMARK_SIZE;
  const scale = 54 / mh;
  ctx.save();
  ctx.translate(72, 60);
  ctx.scale(scale, scale);
  ctx.fillStyle = "#fff";
  ctx.fill(new Path2D(WORDMARK_PATH), "evenodd");
  ctx.restore();
  void mw;

  ctx.font = `500 24px ${FACE}`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.textAlign = "right";
  const when = new Date(d.time * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  ctx.fillText(d.open ? "Open position" : when, W - 72, 98);
  ctx.textAlign = "left";

  // The trade: asset, side, leverage.
  const mid = 200;
  let x = 72;
  if (icon) {
    ctx.drawImage(icon, x, mid - 22, 44, 44);
    x += 58;
  }
  ctx.font = `700 40px ${FACE}`;
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(d.symbol, x, mid + 2);
  x += ctx.measureText(d.symbol).width + 20;
  ctx.textBaseline = "alphabetic";
  x = pill(ctx, d.isLong ? "Long" : "Short", x, mid, d.isLong ? GREEN : RED, "#fff") + 12;
  x = pill(ctx, `${d.leverage}x`, x, mid, "rgba(255, 255, 255, 0.16)", "#fff") + 12;
  if (d.liquidated) pill(ctx, "Liquidated", x, mid, "#fff", RED);

  // The number.
  const roi = roiOf(d);
  const big1 = roiText(roi);
  const size = fit(ctx, big1, 800, 212, W - 144);
  ctx.font = `800 ${size}px ${FACE}`;
  ctx.fillStyle = "#fff";
  ctx.fillText(big1, 66, 410);
  ctx.fillStyle = roi > 0 ? GREEN : roi < 0 ? RED : "rgba(255, 255, 255, 0.4)";
  ctx.fillRect(72, 432, 120, 8);

  ctx.font = `600 36px ${FACE}`;
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillText(`${usd(d.pnl, { sign: true })} on ${usd(d.margin)} of margin`, 72, 494);

  // The figures.
  const figures: [string, string][] = [
    ["Entry", `$${price(d.entry)}`],
    [d.liquidated ? "Liquidated at" : d.open ? "Mark" : "Exit", `$${price(d.exit)}`],
    ["Size", usd(d.margin * BigInt(d.leverage), { cents: false })],
    ["Held", d.held > 0 ? duration(d.held) : "–"],
  ];
  figures.forEach(([label, value], i) => {
    const fx = 72 + i * 270;
    ctx.font = `500 22px ${FACE}`;
    ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
    ctx.fillText(label, fx, 540);
    ctx.font = `600 30px ${FACE}`;
    ctx.fillStyle = "#fff";
    ctx.fillText(value, fx, 576);
  });

  // The foot: where to trade, with the sharer's link.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 606, W, H - 606);
  // A wallet address is too long to read off a picture: the card shows it shortened, the post
  // carries the whole link.
  const shown = link.replace(/^https?:\/\//, "").replace(/(0x[0-9a-fA-F]{4})[0-9a-fA-F]{32}([0-9a-fA-F]{4})/, "$1…$2");
  ctx.font = `600 27px ${FACE}`;
  ctx.fillStyle = NAVY;
  ctx.fillText(shown, 72, 650);
  const linkEnd = 72 + ctx.measureText(shown).width;
  ctx.font = `500 22px ${FACE}`;
  const tagline = "Perps at up to 1000x, on Ethereum";
  if (linkEnd + 40 + ctx.measureText(tagline).width <= W - 72) {
    ctx.fillStyle = "#4b5675";
    ctx.textAlign = "right";
    ctx.fillText(tagline, W - 72, 649);
    ctx.textAlign = "left";
  }
}

const blobOf = (canvas: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));

export function ShareDialog() {
  const data = useStore((s) => s.share);
  const owner = useStore((s) => s.owner);
  const name = useStore((s) => s.account?.name);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const code = name ?? owner;
  const link = `${location.origin}/${code ? `?ref=${code}` : ""}`;

  useEffect(() => {
    if (!data || !canvas.current) return;
    setReady(false);
    drawCard(canvas.current, data, link).then(() => setReady(true));
  }, [data, link]);

  if (!data) return null;
  const file = `${BRAND.toLowerCase()}-${data.symbol.toLowerCase()}-${data.leverage}x.png`;
  const canShareFiles = typeof navigator.canShare === "function";

  return (
    <Dialog title="Share this trade" wide>
      <canvas ref={canvas} className="share-card" aria-label={postText(data)} />
      <div className="share-actions">
        <a
          className="btn primary"
          href={`https://x.com/intent/post?text=${encodeURIComponent(postText(data))}&url=${encodeURIComponent(link)}`}
          target="_blank"
          rel="noreferrer"
        >
          Post on X
        </a>
        <button
          className="btn"
          disabled={!ready}
          onClick={async () => {
            const blob = canvas.current && (await blobOf(canvas.current));
            if (!blob) return;
            try {
              await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
              toast("info", "Image copied", "Paste it into your post.");
            } catch {
              toast("bad", "Could not copy the image", "Download it instead.");
            }
          }}
        >
          Copy image
        </button>
        <button
          className="btn"
          disabled={!ready}
          onClick={async () => {
            const blob = canvas.current && (await blobOf(canvas.current));
            if (!blob) return;
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = file;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}
        >
          Download
        </button>
        {canShareFiles && (
          <button
            className="btn"
            disabled={!ready}
            onClick={async () => {
              const blob = canvas.current && (await blobOf(canvas.current));
              if (!blob) return;
              const files = [new File([blob], file, { type: "image/png" })];
              if (!navigator.canShare({ files })) return toast("bad", "This browser cannot share images", "Download it instead.");
              await navigator.share({ files, text: `${postText(data)} ${link}` }).catch(() => {});
            }}
          >
            Share
          </button>
        )}
      </div>
      <p className="note">
        {code ? "The link on the card is your referral link: you earn a share of the fees of anyone who signs up through it." : "Connect a wallet to put your referral link on the card."}
      </p>
    </Dialog>
  );
}

/** Builds the card's data for a closed trade. */
export function shareTrade(t: { isLong: boolean | null; leverage: number | null; entryPrice: string | null; exitPrice: string; pnl: string; margin: string | null; busted: boolean; entryTime: number | null; time: number }, symbol: string) {
  share({
    symbol,
    isLong: !!t.isLong,
    leverage: t.leverage ?? 1,
    entry: big(t.entryPrice),
    exit: big(t.exitPrice),
    pnl: big(t.pnl),
    margin: big(t.margin),
    liquidated: t.busted,
    open: false,
    held: t.entryTime ? t.time - t.entryTime : 0,
    time: t.time,
  });
}

/** The share button: a small square with the share glyph. */
export function ShareButton({ onClick, label = "Share this trade" }: { onClick: () => void; label?: string }) {
  return (
    <button className="btn small share-btn" onClick={onClick} title={label} aria-label={label}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6" />
      </svg>
    </button>
  );
}
