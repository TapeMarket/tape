import { useEffect, useRef, useState } from "react";
import { Mark } from "./Wordmark";
import { newSupportIdentity, supportHex, supportIdentity, supportRequest, supportStream, type SupportMessage, type SupportThread } from "../lib/support";

export function SupportMessages({ messages, staffView = false }: { messages: SupportMessage[]; staffView?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [messages.length]);
  return <div className="support-messages" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
    {messages.map(message => <article className={`support-message ${message.role} ${message.role === (staffView ? "staff" : "customer") ? "own" : "other"}`} key={message.id}>
      <div className="support-message-meta"><span>{message.role === "staff" ? "Tape support" : staffView ? "Customer" : "You"}</span><time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
      <p>{message.text}</p>
    </article>)}<div ref={end} />
  </div>;
}

export default function SupportChat({ onClose }: { onClose: () => void }) {
  const [identity, setIdentity] = useState(supportIdentity);
  const [thread, setThread] = useState<SupportThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(false);
  const [connected, setConnected] = useState(true);
  const [text, setText] = useState("");
  const [topic, setTopic] = useState("Trading");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const attempt = useRef<{ text: string; id: string } | null>(null);
  const alive = useRef(true);
  const auth = `${identity.id}.${identity.token}`;
  useEffect(() => {
    alive.current = true;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close); input.current?.focus();
    return () => { alive.current = false; window.removeEventListener("keydown", close); };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true); setThread(null); setError("");
    Promise.allSettled([
      supportRequest<SupportThread>(`/conversations/${identity.id}`, auth).then(value => { if (active) { setThread(value); setOnline(value.online); } }).catch((e: Error & { status?: number }) => { if (active && e.status !== 401 && e.status !== 404) setError(e.message); }),
      supportRequest<{ online: boolean }>("/status").then(value => { if (active) setOnline(value.online); }),
    ]).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [auth, identity.id]);
  useEffect(() => {
    if (!thread) return;
    let active = true;
    let refreshing = false;
    let again = false;
    const reload = async () => {
      if (refreshing) { again = true; return; }
      refreshing = true;
      do {
        again = false;
        try { const value = await supportRequest<SupportThread>(`/conversations/${identity.id}`, auth); if (active) { setThread(previous => previous && previous.messages.length > value.messages.length ? previous : value); setOnline(value.online); } }
        catch { /* The reconnect state is visible; retain the last confirmed messages. */ }
      } while (active && again);
      refreshing = false;
    };
    const stop = supportStream(auth, identity.id, value => { setOnline(value.online); if (value.id === identity.id) void reload(); }, setConnected);
    return () => { active = false; stop(); };
  }, [Boolean(thread), auth, identity.id]);
  const submit = async () => {
    const message = text.trim();
    if (!message || sending || loading) return;
    const reference = attempt.current?.text === message ? attempt.current : { text: message, id: supportHex(16) };
    attempt.current = reference;
    setSending(true); setError("");
    try {
      const value = await supportRequest<SupportThread>(thread ? `/conversations/${identity.id}/messages` : "/conversations", thread ? auth : undefined,
        { text: message, messageId: reference.id, ...(!thread ? { ...identity, topic, website: "" } : {}) });
      if (!alive.current) return;
      setThread(previous => previous && previous.messages.length > value.messages.length ? previous : value); setOnline(value.online); setText(""); setSent(true); attempt.current = null;
      input.current?.focus();
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setSending(false); }
  };
  return <section className="support-chat" id="tape-support" role="dialog" aria-label="Tape support">
    <header className="support-head"><div className="support-mark" aria-hidden="true"><Mark size={34} /></div><div><h2>Tape support</h2><span className={`support-status${online ? " online" : ""}`}><i />{!connected ? "Reconnecting…" : online ? "Team available" : "Leave us a message"}</span></div><button className="support-close" onClick={onClose} aria-label="Close support">×</button></header>
    {loading ? <div className="support-intro" role="status">Checking your conversation…</div> : thread ? <>
      <div className="support-ticket"><span>{thread.topic} · #{thread.id.slice(0, 8)}</span><span>{thread.status === "closed" ? "Resolved" : "Open"}</span></div>
      <SupportMessages messages={thread.messages} />
      {thread.status === "closed" && <p className="support-notice">Need anything else? Send a message to reopen this conversation.</p>}
    </> : <div className="support-intro"><span className="support-eyebrow">LET’S SORT IT OUT</span><h3>What can we help with?</h3><p>Send a message to the Tape team. Your conversation stays here in this browser.</p><fieldset><legend>Choose a topic</legend><div className="support-topics">{["Trading", "Deposits", "Withdrawals", "Something else"].map(value => <button type="button" className={topic === value ? "selected" : ""} aria-pressed={topic === value} key={value} onClick={() => setTopic(value)}>{value}</button>)}</div></fieldset></div>}
    {!loading && !online && <p className="support-away">We’re away right now. Leave a message and check back here for our reply.</p>}
    {error && <p className="support-error" role="alert">{error}</p>}
    <form className="support-compose" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <label className="sr-only" htmlFor="support-message">Your message</label>
      <textarea ref={input} id="support-message" rows={3} value={text} onChange={e => setText(e.target.value)} maxLength={3000} placeholder="Tell us what happened…" disabled={loading || sending} onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }} />
      <div><span>{sending ? "Sending…" : sent ? "Message saved" : "No wallet connection needed"}</span><button type="submit" className="support-send" disabled={loading || sending || !text.trim()} aria-label="Send message"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 12-6-4 12-2-5-6-1Zm6 1 6-7" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg></button></div>
    </form>
    <p className="support-safety">Never share private keys or recovery phrases. Messages expire after 90 days without activity.</p>
    {thread?.status === "closed" && <button className="support-new" onClick={() => { setIdentity(newSupportIdentity()); setSent(false); }}>Start a new conversation</button>}
  </section>;
}
