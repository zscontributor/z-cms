"use client";

import { useEffect, useRef, useState } from "react";

type Message = { role: "user" | "assistant"; content: string };

export function AiAssistant({ name, welcomeMessage }: { name: string; welcomeMessage: string }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: welcomeMessage },
  ]);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth" }), [messages, pending]);

  async function send() {
    const content = input.trim();
    if (!content || pending) return;
    const next = [...messages, { role: "user" as const, content }];
    setMessages(next);
    setInput("");
    setPending(true);
    try {
      const response = await fetch("/integrations/ai.assistant/actions/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await response.json() as { answer?: string; message?: string };
      if (!response.ok || !data.answer) throw new Error(data.message || "AI request failed.");
      setMessages((current) => [...current, { role: "assistant", content: data.answer! }]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: error instanceof Error ? error.message : "AI service is unavailable." },
      ]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div style={{ position: "fixed", right: 20, bottom: 20, zIndex: 2147483000, fontFamily: "system-ui, sans-serif" }}>
      {open ? (
        <section
          role="dialog"
          aria-label={name}
          style={{ width: "min(380px, calc(100vw - 32px))", height: "min(560px, calc(100vh - 110px))", display: "flex", flexDirection: "column", overflow: "hidden", borderRadius: 18, background: "#fff", color: "#172033", boxShadow: "0 20px 60px rgba(15,23,42,.25)", border: "1px solid #e2e8f0", marginBottom: 12 }}
        >
          <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", color: "#fff", background: "linear-gradient(135deg,#f4511e,#7c3aed)" }}>
            <strong>{name}</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close assistant" style={{ border: 0, background: "transparent", color: "inherit", fontSize: 24, cursor: "pointer" }}>×</button>
          </header>
          <div aria-live="polite" style={{ flex: 1, overflowY: "auto", padding: 14, background: "#f8fafc" }}>
            {messages.map((message, index) => (
              <div key={index} style={{ display: "flex", justifyContent: message.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
                <div style={{ maxWidth: "82%", whiteSpace: "pre-wrap", padding: "10px 12px", borderRadius: 14, lineHeight: 1.45, fontSize: 14, background: message.role === "user" ? "#7c3aed" : "#fff", color: message.role === "user" ? "#fff" : "#172033", boxShadow: message.role === "assistant" ? "0 1px 3px rgba(15,23,42,.12)" : "none" }}>{message.content}</div>
              </div>
            ))}
            {pending ? <div style={{ fontSize: 13, color: "#64748b", padding: 8 }}>Đang trả lời…</div> : null}
            <div ref={end} />
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void send(); }} style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #e2e8f0" }}>
            <input value={input} onChange={(event) => setInput(event.target.value)} disabled={pending} aria-label="Message" placeholder="Nhập câu hỏi…" maxLength={4000} style={{ minWidth: 0, flex: 1, border: "1px solid #cbd5e1", borderRadius: 999, padding: "10px 14px", font: "inherit", color: "#172033", background: "#fff" }} />
            <button type="submit" disabled={pending || !input.trim()} aria-label="Send message" style={{ width: 42, height: 42, border: 0, borderRadius: 999, color: "#fff", background: "#7c3aed", cursor: "pointer", fontSize: 18 }}>➤</button>
          </form>
        </section>
      ) : null}
      <button type="button" onClick={() => setOpen((value) => !value)} aria-label={`Open ${name}`} style={{ marginLeft: "auto", display: "grid", placeItems: "center", width: 58, height: 58, border: 0, borderRadius: 999, color: "#fff", background: "linear-gradient(135deg,#f4511e,#7c3aed)", boxShadow: "0 10px 30px rgba(79,70,229,.35)", cursor: "pointer", fontSize: 25 }}>✦</button>
    </div>
  );
}
