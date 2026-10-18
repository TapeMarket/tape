import { tx } from "../lib/i18n";
import { useRef, useState, type CSSProperties } from "react";
import { Hero } from "../components/Hero";
import { Panel } from "../components/Panels";
import { PageSection } from "../components/PageSection";
import { Table, useSecond } from "../components/Tables";
import { loadHouse, loadStatus } from "../lib/api";
import { ago, big, duration, percent, shortAddress, usd } from "../lib/format";
import { usePoll } from "../lib/house";
import { PREVIEW } from "../lib/mode";
import { serverNow, useStore } from "../lib/store";
import type { Status } from "../lib/types";

type Block = Status["blocks"][number];

/** A service's state word and the colour of its dot. No dot while the state is not known. */
type State = [word: string, dot: "" | "warn" | "bad" | null];

interface Probe {
  status: Status | null;
  /** Round trip of the last answered request, in milliseconds. */
  ms: number | null;
  /** When that answer arrived, in the relayer's seconds. */
  at: number | null;
  failed: boolean;
}

/** Seconds without a tick before a feed counts as late. The relayer refuses orders at the same age. */
const STALE_AFTER = 6;
/** A request that has not answered by now counts as failed, so a relayer that hangs reads as down. */
const PROBE_TIMEOUT = 8_000;
/** 0.004 ETH in wei. A Pyth oracle pays the fee on every price update out of this balance. */
const LOW_FLOAT = 4_000_000_000_000_000n;
/** Blocks the indexer may trail the chain by before it counts as behind. */
const MAX_LAG = 3n;

const SOURCES: Record<string, string> = { hyperliquid: "Hyperliquid", hermes: "Pyth", preview: "Hyperliquid, preview", dev: "Simulated, local test" };

const timeout = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("No answer in time.")), ms));

/** "84 ms", "1.06 s" */
function latency(ms: number): string {
  if (ms < 1) return "<1 ms";
  return ms < 999.5 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Wei as ETH: "0.1234" */
const eth = (wei: string): string => (Number(big(wei) / 10n ** 12n) / 1e6).toFixed(4);

/** A base fee in wei as gwei: "12.40", "0.27", "0.004" */
function gwei(wei: string): string {
  const n = Number(big(wei)) / 1e9;
  return n.toFixed(n === 0 || n >= 0.1 ? 2 : 3);
}

/** How full a block was, from 0 to 1. */
function fullness(block: Block): number {
  const limit = Number(big(block.gasLimit));
  return limit > 0 ? Number(big(block.gasUsed)) / limit : 0;
}

/** Whether the exchange is up, as seen from this browser: one request every few seconds. */
export function StatusPage() {
  const [probe, setProbe] = useState<Probe>({ status: null, ms: null, at: null, failed: false });
  const [houseOk, setHouseOk] = useState<boolean | null>(null);
  const busy = useRef(false);
  const house = useStore((s) => s.house);
  const now = useSecond();

  usePoll(async () => {
    // One request at a time, so a slow answer can never land on top of a newer one.
    if (busy.current) return;
    busy.current = true;
    const sent = performance.now();
    try {
      const status = await Promise.race([loadStatus(), timeout(PROBE_TIMEOUT)]);
      setProbe({ status, ms: performance.now() - sent, at: serverNow(), failed: false });
    } catch {
      setProbe((last) => ({ ...last, failed: true }));
    } finally {
      busy.current = false;
    }
  }, 3_000);
  usePoll(
    () =>
      loadHouse().then(
        () => setHouseOk(true),
        () => setHouseOk(false),
      ),
    5_000,
  );

  const { status, failed } = probe;
  // What can be vouched for right now: nothing, once a request has failed.
  const live = failed ? null : status;
  const preview = status ? status.chainId === 0 : PREVIEW;

  // Ages are taken at the moment the relayer answered, so the wait between two checks never counts against a feed.
  const asOf = status ? Math.floor(status.time / 1000) : 0;
  const ages = (status?.feeds ?? []).filter((feed) => !feed.retired).map((feed) => (feed.time === null ? Infinity : Math.max(0, asOf - feed.time)));
  const feedAge = ages.length ? Math.max(...ages) : null;
  const delayed = feedAge !== null && feedAge > STALE_AFTER;

  const blocks = [...(status?.blocks ?? [])].sort((a, b) => Number(big(a.number) - big(b.number)));
  const head = blocks.at(-1);
  const lag = status && head ? big(head.number) - big(status.block) : 0n;

  let headline = "All systems normal";
  let badge: [word: string, tone: string] = ["Operational", "up"];
  if (failed) {
    headline = "Relayer unreachable";
    badge = ["Down", "down"];
  } else if (!status) {
    headline = "Checking.";
    badge = ["Checking", ""];
  } else if (delayed) {
    headline = "Price feed delayed";
    badge = ["Degraded", "warn"];
  } else if (status.opensPaused) {
    headline = "New positions paused";
    badge = ["Degraded", "warn"];
  } else if (houseOk === false) {
    headline = "State API unavailable";
    badge = ["Degraded", "warn"];
  } else if (!preview && (!head || lag > MAX_LAG)) {
    headline = "Indexer catching up";
    badge = ["Degraded", "warn"];
  } else if (!status.ok) {
    headline = "Some services need attention";
    badge = ["Degraded", "warn"];
  } else if (houseOk === null) {
    headline = "Checking services";
    badge = ["Checking", ""];
  }

  const pending: State = [failed ? "Unknown" : "Checking", null];
  const online = (up: boolean | null): State => (up === null ? pending : up ? ["Online", ""] : ["Down", "bad"]);
  // In preview there is no relayer: the first two rows are the exchange in this tab and the prices it listens to.
  const services: ([label: string, state: State] | false)[] = [
    [preview ? "Preview engine" : "Relayer intake", online(failed ? false : status ? true : null)],
    [preview ? "Price stream" : "State API", online(preview ? (live ? live.ok : null) : houseOk)],
    ["Price feed", !live ? pending : delayed ? ["Delayed", "warn"] : ["Live", ""]],
    !preview && ["Indexed blocks", !live ? pending : !head ? ["No data", "warn"] : lag > MAX_LAG ? ["Behind", "warn"] : ["Live", ""]],
    ["Trading state", !live ? pending : live.opensPaused ? ["Paused", "warn"] : ["Open", ""]],
    // Only an oracle that pays Pyth keeps a float. Signed prices cost nothing to read.
    !preview && live?.oracleFloat != null && ["Oracle float", big(live.oracleFloat) < LOW_FLOAT ? ["Low", "warn"] : ["OK", ""]],
  ];

  const figures: [label: string, value: string][] = [
    ["Open positions", status ? status.openPositions.toLocaleString("en-US") : "–"],
    ["Live connections", status ? status.streams.toLocaleString("en-US") : "–"],
    ["Operator gas", status && !preview ? `${eth(status.operatorEth)} ETH` : "–"],
  ];

  const tone = badge[1] === "down" ? "bad" : badge[1] === "warn" ? "warn" : "";
  return (
    <div className="sheet work-page status-page">
      <Hero
        title={<span aria-live="polite">{tx(headline)}</span>}
        lede={probe.at === null ? (failed ? tx("No answer yet.") : tx("Checking.")) : tx("Checked {0} ago, every few seconds while this page is open.", [ago(probe.at, now)])}
        actions={
          <span className={`verdict ${tone}`}>
            <i />
            {tx(badge[0])}
          </span>
        }
        figures={[
          { label: "Probe latency", value: probe.ms === null || failed ? "–" : latency(probe.ms), hint: "Round trip of one status request. Not trade confirmation." },
          {
            label: "Price feed",
            value: feedAge === null ? "–" : Number.isFinite(feedAge) ? duration(feedAge) : "No tick",
            hint: status ? `Oldest price across markets. Source: ${SOURCES[status.source] ?? status.source}.` : undefined,
          },
          { label: "Ethereum", value: !status ? "–" : preview ? "Preview" : `#${big(status.block).toLocaleString("en-US")}` },
          { label: "Queue", value: house ? house.queueStats.entries.toLocaleString("en-US") : "–", tone: house && big(house.house.totalQueued) > 0n ? "warn" : "" },
          ...figures.map(([label, value]) => ({ label, value })),
        ]}
      />

      <PageSection title={tx("Services")} detail={tx("Current availability of the exchange, prices and settlement data.")}>
        <div className="lamps">
          {services.map(
            (service) =>
              service && (
                <div className={`lamp ${service[1][1] ?? "unknown"}`} key={service[0]}>
                  <span>{tx(service[0])}</span>
                  <span>
                    {service[1][1] !== null && <i className={`dot ${service[1][1]}`} />}
                    {tx(service[1][0])}
                  </span>
                </div>
              ),
          )}
        </div>
      </PageSection>

      <PageSection title={tx("Settlement")} detail={tx("The Ethereum blocks trades settle in, and the next winnings waiting to be paid.")}>
      <div className="cells status-grid">
        <Panel
          title={tx("Ethereum blocks")}
          tools={
            <span className="seg">
              <span className={`live ${live && !preview ? "" : "off"}`}>{preview ? tx("Preview") : live ? tx("Live") : tx("Waiting")}</span>
            </span>
          }
        >
          <div className="panel-body">
            {preview ? (<p className="note">{tx("There are no blocks in preview. Once the contracts are live this shows the chain they settle on.")}</p>) : blocks.length === 0 ? (<p className="note">{status ? tx("The node sent no recent blocks.") : tx("Checking.")}</p>) : (<>
                {/* Oldest on the left. When they do not all fit, the old ones are the ones cut off. */}
                <div className="blocks" style={{ justifyContent: "flex-end" }}>
                  {blocks.map((block) => {
                    const used = fullness(block);
                    return (
                      <div className={`block ${block === head ? "head" : ""}`} key={block.number}>
                        <header>
                          <span>{block === head ? tx("Latest") : tx("Mined")}</span>
                          <b>{percent(used, 1)}</b>
                        </header>
                        <div className="gauge" aria-hidden="true" style={{ "--used": percent(Math.min(used, 1), 1) } as CSSProperties} />
                        <footer>
                          #{block.number} / {(Number(big(block.gasUsed)) / 1e6).toFixed(2)}{tx("M gas / ")}{gwei(block.baseFee)} {tx(" gwei ")}</footer>
                      </div>
                    );
                  })}
                </div>
                <p className="note">{tx("How full recent blocks were. Trades settle inside these.")}</p>
              </>)}
          </div>
        </Panel>

        <Panel title={tx("Next queued payouts")} tools={<span className="dim">{tx("Top 10")}</span>}>
          <Table head={["#", "User", ["Amount", "r"], ["Waiting", "r"]]} empty={failed ? tx("Payout data is unavailable while the relayer is unreachable.") : status ? tx("The queue is empty. Every winner has been paid.") : tx("Checking.")}>
            {(status?.queue ?? []).map((entry, i) => (
              <tr key={entry.id}>
                <td className="soft">{i + 1}</td>
                <td>{shortAddress(entry.user)}</td>
                <td className="r">
                  <b>{usd(entry.amount)}</b>
                </td>
                <td className="r soft">{ago(entry.time, now)}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>
      </PageSection>
    </div>
  );
}
