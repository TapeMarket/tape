import { useEffect, useState } from "react";
import { loadJackpot } from "./api";
import { useStore } from "./store";
import type { JackpotPayload } from "./types";

export function clockText(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

export function useJackpot(): JackpotPayload | null {
  const owner = useStore((s) => s.owner);
  const [jackpot, setJackpot] = useState<JackpotPayload | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => loadJackpot(owner).then((next) => alive && setJackpot(next), () => {});
    load();
    const timer = setInterval(load, 8_000);
    return () => { alive = false; clearInterval(timer); };
  }, [owner]);
  return jackpot && jackpot.address ? jackpot : null;
}
