/**
 * Pyth Hermes: the production price source.
 *
 * Hermes serves guardian-signed price updates. It is not a trust dependency: every blob is verified
 * on-chain against Pyth's guardians, so a lying Hermes cannot produce a fill. It can only fail to
 * produce one, in which case the intent expires unfilled.
 *
 * Auth: `Authorization: Bearer <PYTH_API_KEY>`, and the key must be entitled to each feed.
 *   no key            -> 401
 *   key without feed  -> 403 "Not entitled"
 *
 * One stream per feed, so that each blob carries exactly one price and costs the least to verify.
 */

const RECONNECT_MS = 1500;
// Hermes sends a price several times a second. A stream that has said nothing for this long is
// connected and dead: drop it and connect again, instead of waiting on it for ever.
const STALL_MS = 10_000;

export class HermesAuthError extends Error {}

export function createHermesSource({ markets, book, log, baseUrl, apiKey, fetchImpl = fetch, stallMs = STALL_MS, reconnectMs = RECONNECT_MS }) {
  const headers = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let stopped = false;
  const controllers = new Set();

  function toPrint(parsed, blob) {
    const expo = Number(parsed.price.expo);
    const scale = (value) => {
      const shift = expo + 8;
      return shift >= 0 ? BigInt(value) * 10n ** BigInt(shift) : BigInt(value) / 10n ** BigInt(-shift);
    };
    return {
      time: Number(parsed.price.publish_time),
      prev: Number(parsed.metadata?.prev_publish_time ?? parsed.price.publish_time - 1),
      price: scale(parsed.price.price),
      conf: scale(parsed.price.conf),
      blob: blob.startsWith("0x") ? blob : `0x${blob}`,
      at: Date.now(),
    };
  }

  async function check(res, feedId) {
    if (res.status === 401 || res.status === 403) {
      const body = (await res.text()).trim().slice(0, 160);
      throw new HermesAuthError(`Hermes refused feed ${feedId} (${res.status}: ${body}). Set PYTH_API_KEY to a key entitled to it.`);
    }
    if (!res.ok) throw new Error(`Hermes ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }

  /** The first print at or after `time`, straight from Hermes. */
  async function at(marketId, time) {
    const market = markets.find((m) => m.id === marketId);
    const id = market.feedId.slice(2);
    const res = await fetchImpl(`${baseUrl}/v2/updates/price/${time}?ids%5B%5D=0x${id}&encoding=hex&parsed=true`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    await check(res, market.feedId);
    const json = await res.json();
    if (!json?.parsed?.[0] || !json?.binary?.data?.[0]) return null;
    return toPrint(json.parsed[0], json.binary.data[0]);
  }

  async function stream(market) {
    const id = market.feedId.slice(2);
    const url = `${baseUrl}/v2/updates/price/stream?ids%5B%5D=0x${id}&encoding=hex&parsed=true&allow_unordered=false`;
    while (!stopped) {
      const controller = new AbortController();
      controllers.add(controller);
      let stalled = false;
      let watchdog;
      const heard = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          stalled = true;
          controller.abort();
        }, stallMs);
      };
      try {
        heard();
        const res = await fetchImpl(url, { headers: { ...headers, accept: "text/event-stream" }, signal: controller.signal });
        await check(res, market.feedId);
        log.info(`hermes: streaming ${market.symbol}`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body) {
          heard();
          buffer += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              try {
                const json = JSON.parse(line.slice(5));
                if (json?.parsed?.[0] && json?.binary?.data?.[0]) book.add(market.id, toPrint(json.parsed[0], json.binary.data[0]));
              } catch {
                // A malformed event is skipped; the next one replaces it within the second.
              }
            }
          }
        }
      } catch (error) {
        if (stopped) return;
        if (error instanceof HermesAuthError) {
          // Retrying will not help until the key is fixed. Say so loudly, then keep checking slowly.
          log.error(error.message);
          await new Promise((r) => setTimeout(r, 60_000));
          continue;
        }
        log.warn(`hermes: ${market.symbol} stream ${stalled ? `went quiet for ${stallMs / 1000}s` : `dropped (${error.message})`}; reconnecting`);
      } finally {
        clearTimeout(watchdog);
        controllers.delete(controller);
      }
      await new Promise((r) => setTimeout(r, reconnectMs));
    }
  }

  return {
    name: "hermes",
    start() {
      for (const market of markets) stream(market);
    },
    stop() {
      stopped = true;
      for (const controller of controllers) controller.abort();
    },
    at,
  };
}
