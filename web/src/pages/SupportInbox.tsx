import { tx } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { SupportMessages } from "../components/SupportChat";
import { supportHex, supportRequest, supportStream, type SupportSummary, type SupportThread } from "../lib/support";
import { getState, setState, useStore } from "../lib/store";
import { getSigner } from "../lib/wallet";
import "../components/support.css";

interface StaffSession { token: string; owner: string; until: number }
const SLOT = "tape:support:staff";
function storedSession(): StaffSession | null {
  try { const value = JSON.parse(sessionStorage.getItem(SLOT) ?? "null"); return value?.until > Date.now() && /^[a-f0-9]{64}$/.test(value.token) ? value : null; } catch { return null; }
}
export function SupportInbox() {
  const owner = useStore(s => s.owner);
  const [session, setSession] = useState(storedSession);
  const [items, setItems] = useState<SupportSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<SupportThread | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(true);
  const [available, setAvailable] = useState(false);
  const [alerts, setAlerts] = useState(false);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const seen = useRef(new Map<string, string>());
  const drafts = useRef(new Map<string, string>());
  const reply = useRef<{ id: string; text: string; thread: string } | null>(null);
  const token = session?.token;
  const signOut = () => { setSession(null); setItems([]); setThread(null); setSelected(null); setAvailable(false); try { sessionStorage.removeItem(SLOT); } catch { /* Already cleared. */ } };
  const previousOwner = useRef(owner);
  useEffect(() => {
    if (session && ((owner && owner.toLowerCase() !== session.owner.toLowerCase()) || (previousOwner.current && !owner) || session.until <= Date.now())) signOut();
    previousOwner.current = owner;
  }, [owner, session]);
  useEffect(() => { if (!session) return; const timer = setTimeout(signOut, Math.max(0, session.until - Date.now())); return () => clearTimeout(timer); }, [session]);
  const loadThread = async (id: string) => {
    if (!token) return;
    const value = await supportRequest<SupportThread>(`/tickets/${id}`, token);
    if (selectedRef.current !== id) return;
    setThread(previous => previous?.id === id && previous.messages.length > value.messages.length ? previous : value);
    const last = value.messages.filter(m => m.role === "customer").at(-1)?.id;
    if (last && last !== seen.current.get(id)) {
      seen.current.set(id, last);
      void supportRequest(`/tickets/${id}/seen`, token, {}).catch(() => {});
    }
  };
  useEffect(() => {
    if (!token) return;
    let active = true;
    let loading = false;
    let again = false;
    const reload = async (event?: { id?: string }) => {
      if (loading) { again = true; return; }
      loading = true;
      do {
        again = false;
        try {
          const value = await supportRequest<{ conversations: SupportSummary[] }>("/inbox", token);
          if (active) { setItems(value.conversations); setError(""); }
          if (active && selectedRef.current) await loadThread(selectedRef.current);
          if (active && event?.id && alerts && document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") new Notification("New Tape support message", { body: "A conversation was updated. Open your support inbox.", tag: event.id });
        } catch (e) { if (active) { setError((e as Error).message); if ((e as { status?: number }).status === 401) signOut(); } }
      } while (active && again);
      loading = false;
    };
    void reload();
    const stop = supportStream(token, null, value => { void reload(value); }, setConnected);
    return () => { active = false; stop(); };
  }, [token, alerts]);
  useEffect(() => {
    if (!token || !selected) return;
    let active = true;
    setThread(null); setText(drafts.current.get(selected) ?? ""); setLoading(true); setError("");
    loadThread(selected).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, selected]);
  useEffect(() => {
    if (!token) return;
    const update = () => { void supportRequest("/presence", token, { available: available && document.visibilityState === "visible" && document.hasFocus() }).catch(() => {}); };
    update(); const timer = setInterval(update, 20_000);
    window.addEventListener("focus", update); window.addEventListener("blur", update); document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); window.removeEventListener("blur", update); document.removeEventListener("visibilitychange", update); void supportRequest("/presence", token, { available: false }).catch(() => {}); };
  }, [token, available]);
  const login = async () => {
    if (busy) return;
    if (!owner) { setState({ dialog: "connect" }); return; }
    setBusy(true); setError("");
    try {
      const signer = await getSigner();
      if (!signer) throw Error("Connect your support wallet first.");
      const challenge = await supportRequest<{ nonce: string; message: string }>("/auth/challenge", undefined, { owner: signer.address });
      const signature = await signer.signMessage(challenge.message);
      if (getState().owner?.toLowerCase() !== signer.address.toLowerCase()) throw Error("Your wallet changed. Sign in again.");
      const result = await supportRequest<{ token: string; until: number }>("/auth", undefined, { nonce: challenge.nonce, signature });
      const value = { ...result, owner: signer.address };
      try { sessionStorage.setItem(SLOT, JSON.stringify(value)); } catch { /* This tab still has its session. */ }
      setSession(value);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const send = async () => {
    const message = text.trim();
    if (!token || !selected || !message || busy) return;
    const id = selected;
    const attempt = reply.current?.thread === id && reply.current.text === message ? reply.current : { id: supportHex(16), text: message, thread: id };
    reply.current = attempt; setBusy(true); setError("");
    try {
      const value = await supportRequest<SupportThread>(`/tickets/${id}/messages`, token, { text: message, messageId: attempt.id });
      drafts.current.delete(id); reply.current = null;
      if (selectedRef.current === id) { setThread(value); setText(""); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const resolve = async () => {
    if (!token || !selected || busy) return;
    const id = selected; setBusy(true); setError("");
    try { const value = await supportRequest<SupportThread>(`/tickets/${id}/resolve`, token, {}); if (selectedRef.current === id) setThread(value); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <div className="support-inbox">
    <header className="support-inbox-head"><div><h1>{tx("Support inbox")}</h1><p>{session ? tx("{0} open conversations{1}", [items.filter(item => item.status === "open").length, connected ? " · Live updates" : " · Reconnecting…"]) : tx("Customer conversations, handled by the Tape team.")}</p></div>{session && <div className="support-inbox-actions"><button className={`btn${available ? " primary" : ""}`} onClick={() => setAvailable(value => !value)}>{available ? tx("Accepting chats") : tx("Go online")}</button>{"Notification" in window && !alerts && <button className="btn" onClick={async () => { if (await Notification.requestPermission() === "granted") setAlerts(true); }}>{tx("Enable alerts")}</button>}<button className="btn" onClick={() => { void supportRequest("/logout", token, {}).catch(() => {}); signOut(); }}>{tx("Sign out")}</button></div>}</header>
    {error && <p className="support-error" role="alert">{error}</p>}
    {!session ? <section className="support-inbox-login"><span className="support-eyebrow">{tx("STAFF ACCESS")}</span><h2>{tx("A real conversation starts here.")}</h2><p>{tx("Connect an authorized Tape support wallet and sign in to read messages, reply, and resolve customer issues. Signing in does not send a transaction.")}</p><button className="btn primary" disabled={busy} onClick={() => { void login(); }}>{busy ? tx("Check your wallet…") : owner ? tx("Sign in to inbox") : tx("Connect support wallet")}</button></section> : <>
      <div className="support-inbox-grid"><nav className="support-inbox-list" aria-label={tx("Customer conversations")}>{items.length ? items.map(item => <button key={item.id} className={selected === item.id ? "selected" : ""} aria-current={selected === item.id ? "true" : undefined} onClick={() => { setSelected(item.id); selectedRef.current = item.id; }}><strong>{item.topic}{item.unread > 0 && <span className="support-unread">{item.unread}</span>}</strong><p>{item.preview}</p><small>#{item.id.slice(0, 8)} · {item.status === "closed" ? tx("Resolved") : tx("Open")}</small></button>) : <div className="support-inbox-empty">{tx("No conversations yet. New customer messages will appear here.")}</div>}</nav>
      <section className="support-inbox-thread" aria-label={tx("Selected conversation")}>{loading ? <div className="support-inbox-empty" role="status">{tx("Opening conversation…")}</div> : thread ? <><div className="support-ticket"><span>{tx(thread.topic)} · #{thread.id.slice(0, 8)}</span><button className="btn" disabled={busy || thread.status === "closed"} onClick={() => { void resolve(); }}>{thread.status === "closed" ? tx("Resolved") : tx("Mark resolved")}</button></div><SupportMessages messages={thread.messages} staffView /><form className="support-compose" onSubmit={e => { e.preventDefault(); void send(); }}><label className="sr-only" htmlFor="support-reply">{tx("Reply to customer")}</label><textarea id="support-reply" rows={3} placeholder={tx("Write a reply…")} maxLength={3000} value={text} disabled={busy} onChange={e => { setText(e.target.value); drafts.current.set(thread.id, e.target.value); }} /><div><span>{busy ? tx("Sending…") : tx("Replies are delivered to the customer’s chat")}</span><button type="submit" className="btn primary" disabled={busy || !text.trim()}>{tx("Send reply")}</button></div></form></> : <div className="support-inbox-empty">{tx("Choose a conversation to read and reply.")}</div>}</section></div>
      <p className="support-inbox-note">{tx("Go online while you’re ready to help. Availability turns off when this tab loses focus. Messages remain private and expire after 90 days without activity.")}</p>
    </>}
  </div>;
}
