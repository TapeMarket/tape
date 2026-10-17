import { API_URL } from "./mode";

export interface SupportMessage { id: string; text: string; role: "customer" | "staff"; at: number }
export interface SupportThread { id: string; topic: string; status: "open" | "closed"; createdAt: number; updatedAt: number; messages: SupportMessage[]; online: boolean }
export interface SupportSummary { id: string; topic: string; status: "open" | "closed"; createdAt: number; updatedAt: number; preview: string; unread: number }
export interface SupportIdentity { id: string; token: string }
const KEY = "tape:support:conversation";
export const supportHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(value => value.toString(16).padStart(2, "0")).join("");

export function supportIdentity(): SupportIdentity {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (/^[a-f0-9]{32}$/.test(saved?.id ?? "") && /^[a-f0-9]{64}$/.test(saved?.token ?? "")) return saved;
  } catch { /* A blocked browser store still permits a conversation in this tab. */ }
  const identity = { id: supportHex(16), token: supportHex(32) };
  try { localStorage.setItem(KEY, JSON.stringify(identity)); } catch { /* Kept by the component. */ }
  return identity;
}
export function newSupportIdentity(): SupportIdentity {
  try { localStorage.removeItem(KEY); } catch { /* The tab can still start a new conversation. */ }
  return supportIdentity();
}
export async function supportRequest<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}/support${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error ?? "Support could not be reached. Please retry."), { status: response.status });
  return result as T;
}

/** Auth stays in a header. The URL and server access logs never contain conversation secrets. */
export function supportStream(token: string, id: string | null, onUpdate: (value: { id?: string; online: boolean }) => void, onConnection?: (connected: boolean) => void) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const run = async () => {
    try {
      const response = await fetch(`${API_URL}/support/events${id ? `?id=${id}` : ""}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("Support stream unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      onConnection?.(true); attempt = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = event.split("\n").find(line => line.startsWith("data: "))?.slice(6);
          if (data) { try { onUpdate(JSON.parse(data)); } catch { /* Ignore an incomplete event. */ } }
        }
        if (buffer.length > 64_000) throw new Error("Support stream interrupted");
      }
    } catch { /* Reconnect without dropping the conversation or unsent message. */ }
    if (!controller.signal.aborted) { onConnection?.(false); timer = setTimeout(run, Math.min(15_000, 1000 * 2 ** attempt++)); }
  };
  void run();
  return () => { controller.abort(); clearTimeout(timer); };
}
