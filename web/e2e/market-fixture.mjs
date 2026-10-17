export const PRICES = { BTC: 80000, ETH: 2500, SOL: 150, XRP: 1, DOGE: 0.2, "xyz:GOLD": 2600, "xyz:SP500": 6000, "xyz:TSLA": 250, "xyz:NVDA": 140, "xyz:AAPL": 230 };

export async function marketFixture(context, { prices = PRICES, paused = new Set(), errors = [] } = {}) {
  await context.route("https://api.hyperliquid.xyz/info", async (route) => {
    const b = route.request().postDataJSON();
    const names = Object.keys(prices).filter((coin) => coin.includes(":") === Boolean(b.dex));
    let data;
    if (b.type === "allMids") data = Object.fromEntries(names.filter((name) => !paused.has(name)).map((name) => [name, String(prices[name])]));
    else if (b.type === "metaAndAssetCtxs") data = [{ universe: names.map((name) => ({ name })) }, names.map((name) => ({ prevDayPx: String(prices[name] * .99), oraclePx: String(prices[name]), markPx: String(prices[name]), dayNtlVlm: String(prices[name] * 10000), openInterest: "100" }))];
    else if (b.type === "recentTrades") data = Array.from({ length: 100 }, (_, i) => ({ px: String(prices[b.coin]), time: Date.now() - (99 - i) * 1000 }));
    else if (b.type === "candleSnapshot") { const p = String(prices[b.req.coin]); data = Array.from({ length: 300 }, (_, i) => ({ t: Math.floor(Date.now() / 60000) * 60000 - (299 - i) * 60000, o: p, h: p, l: p, c: p })); }
    else throw Error(`Unexpected request ${b.type}`);
    await route.fulfill({ json: data });
  });
  await context.routeWebSocket("wss://api.hyperliquid.xyz/ws", (ws) => {
    const coins = new Set();
    const tick = () => { for (const coin of coins) { if (paused.has(coin)) continue; const p = prices[coin]; ws.send(JSON.stringify({ channel: "bbo", data: { coin, time: Date.now(), bbo: [{ px: String(p * .999999) }, { px: String(p * 1.000001) }] } })); } };
    ws.onMessage((msg) => { const b = JSON.parse(String(msg)); if (b.method === "subscribe") { coins.add(b.subscription.coin); tick(); } });
    const timer = setInterval(tick, 300); ws.onClose(() => clearInterval(timer));
  });
  context.on("page", (page) => page.on("pageerror", (e) => errors.push(e.message)));
}
