/**
 * The price book: the recent prints of every market, whatever their source.
 *
 * A print is one signed oracle update: { time, prev, price, conf, blob, at }.
 *   time   publish time, unix seconds
 *   prev   publish time of the print before it
 *   price  1e8 bigint
 *   conf   1e8 bigint
 *   blob   the update exactly as the contract takes it
 *   at     when we received it, unix ms
 *
 * Two questions are asked of it:
 *   pinned(market, t)   the fill price of an intent: the FIRST print at or after second t. The
 *                       contract enforces the same rule, so this must find the same print.
 *   ticks               every print as it arrives, for charts and for spotting bust touches.
 */

const KEEP_SECONDS = 30 * 60;

export function createBook(marketIds) {
  const prints = new Map(marketIds.map((id) => [id, []]));
  const listeners = new Set();
  const waiters = new Set();

  function add(marketId, print) {
    const list = prints.get(marketId);
    if (!list) return;
    const last = list[list.length - 1];
    if (last && print.time < last.time) return; // out of order, ignore
    list.push(print);
    while (list.length && list[0].time < print.time - KEEP_SECONDS) list.shift();
    for (const listener of listeners) listener(marketId, print);
    for (const waiter of waiters) if (waiter.marketId === marketId) waiter.check();
  }

  /**
   * Puts back a print from before this process started (the print log). Nobody is told: it is
   * history, there to be found, not a tick to act on.
   */
  function restore(marketId, print) {
    const list = prints.get(marketId);
    if (!list) return;
    const last = list[list.length - 1];
    if (last && print.time < last.time) return;
    list.push(print);
  }

  function latest(marketId) {
    const list = prints.get(marketId);
    return list?.[list.length - 1] ?? null;
  }

  /** One point per second for the last `seconds`, oldest first. */
  function history(marketId, seconds) {
    const list = prints.get(marketId) ?? [];
    const from = Math.floor(Date.now() / 1000) - seconds;
    const out = [];
    let lastTime = -1;
    for (const p of list) {
      if (p.time < from || p.time === lastTime) continue;
      out.push({ t: p.time, p: p.price.toString() });
      lastTime = p.time;
    }
    return out;
  }

  /** The first stored print at or after `minTime`, if it is provably the first one published. */
  function findPinned(marketId, minTime) {
    const list = prints.get(marketId) ?? [];
    for (const p of list) {
      if (p.time < minTime) continue;
      return p.prev < minTime ? { print: p } : { missedFirst: true };
    }
    return {};
  }

  /**
   * Resolves with the print an intent pinned at `minTime` fills at.
   * @param {(marketId: number, minTime: number) => Promise<object|null>} [fallback] asked when the
   *        book holds a later print of that second but not the first one.
   */
  function pinned(marketId, minTime, windowSeconds, fallback) {
    return new Promise((resolve, reject) => {
      const deadline = (minTime + windowSeconds + 3) * 1000;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(waiter);
        fn(value);
      };
      const waiter = {
        marketId,
        check() {
          const found = findPinned(marketId, minTime);
          if (found.print) {
            if (found.print.time > minTime + windowSeconds) finish(reject, new Error("no price inside the window"));
            else finish(resolve, found.print);
          } else if (found.missedFirst) {
            if (!fallback) return finish(reject, new Error("first print of the second was missed"));
            fallback(marketId, minTime).then(
              (print) => (print && print.prev < minTime && print.time >= minTime && print.time <= minTime + windowSeconds ? finish(resolve, print) : finish(reject, new Error("no usable price"))),
              (error) => finish(reject, error),
            );
          }
        },
      };
      const timer = setTimeout(() => finish(reject, new Error("price did not arrive in time")), Math.min(2 ** 31 - 1, Math.max(0, deadline - Date.now())));
      waiters.add(waiter);
      waiter.check();
    });
  }

  /** Every stored print of `marketId` published in (after, upTo]. */
  function between(marketId, after, upTo) {
    return (prints.get(marketId) ?? []).filter((p) => p.time > after && p.time <= upTo);
  }

  return {
    add,
    restore,
    latest,
    history,
    pinned,
    between,
    betweenMs: (marketId, after, upTo) => (prints.get(marketId) ?? []).filter(p => p.observedAt > after && p.observedAt <= upTo),
    /** The print an intent pinned at `minTime` fills at, if the book holds it. */
    firstAt: (marketId, minTime) => findPinned(marketId, minTime).print ?? null,
    onTick(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
