// Where the site gets its data.
//
//   live      a relayer (VITE_API_URL, or the local one while developing) in front of the contracts
//   preview   no relayer at all: an exchange that runs inside this browser tab, with real market
//             prices and play money. This is what a static host serves until
//             the contracts are deployed and VITE_API_URL points at their relayer.

const env = import.meta.env;
const forced = typeof location !== "undefined" && new URLSearchParams(location.search).get("preview") === "1";

export const API_URL: string = (env.VITE_API_URL as string | undefined) ?? (env.DEV ? "http://127.0.0.1:8787" : "");
export const PREVIEW: boolean = forced || env.VITE_PREVIEW === "1" || API_URL === "";
export const BRAND: string = (env.VITE_BRAND as string | undefined) ?? "Tape";
/** The coin's ticker in preview mode. In live mode it is read from the coin's own contract. */
export const COIN: string = (env.VITE_COIN as string | undefined) ?? "TAPE";
