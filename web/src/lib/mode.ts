// Where the site gets its data.
//
//   live      a relayer (VITE_API_URL, or the local one while developing) in front of the contracts
//   preview   no relayer at all: an exchange that runs inside this browser tab, with real market
//             prices and play money. This is what a static host serves until
//             the contracts are deployed and VITE_API_URL points at their relayer.

const env = import.meta.env;
const forced = typeof location !== "undefined" && new URLSearchParams(location.search).get("preview") === "1";

const configuredApi = (env.VITE_API_URL as string | undefined) ?? (env.DEV ? "http://127.0.0.1:8787" : "");
const requestedVersion = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("legacy");
export const LEGACY_VERSION: string | null = !forced && env.VITE_PREVIEW !== "1" && Boolean(configuredApi) && (requestedVersion === "1" || requestedVersion === "2") ? requestedVersion : null;
export const LEGACY: boolean = LEGACY_VERSION !== null;
export const API_URL: string = LEGACY ? `${configuredApi.replace(/\/v\d+\/?$/, "").replace(/\/$/, "")}/v${LEGACY_VERSION}` : configuredApi;
export const exchangeHref = (to: string): string => LEGACY ? `${to}${to.includes("?") ? "&" : "?"}legacy=${LEGACY_VERSION}` : to;
export const PREVIEW: boolean = forced || env.VITE_PREVIEW === "1" || API_URL === "";
export const BRAND: string = (env.VITE_BRAND as string | undefined) ?? "Tape";
/** The coin's ticker in preview mode. In live mode it is read from the coin's own contract. */
export const COIN: string = (env.VITE_COIN as string | undefined) ?? "TAPE";
