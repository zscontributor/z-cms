"use client";

import { useState, useTransition } from "react";
import { zaiAdminChatAction, type ZaiAdminMessage } from "@/app/actions/zai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";

export function ZaiAdmin() {
  const [messages, setMessages] = useState<ZaiAdminMessage[]>([
    { role: "assistant", content: "Bạn có thể yêu cầu tôi liệt kê, tạo, sửa, publish, unpublish hoặc xóa pages/blogs." },
  ]);
  const [input, setInput] = useState("");
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [pending, startTransition] = useTransition();

  function send(confirmDestructive = false) {
    const content = input.trim();
    const next = confirmDestructive
      ? messages.slice(0, -1)
      : [...messages, { role: "user" as const, content }];
    if ((!content && !confirmDestructive) || pending) return;
    if (!confirmDestructive) {
      setMessages(next);
      setInput("");
    }
    setConfirmationRequired(false);
    startTransition(async () => {
      const result = await zaiAdminChatAction(next, confirmDestructive);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: result.ok ? result.answer : result.error,
        },
      ]);
      setConfirmationRequired(result.ok && result.confirmationRequired === true);
    });
  }

  return (
    <div className="z-card mx-auto flex min-h-[620px] max-w-4xl flex-col overflow-hidden">
      <div className="border-b border-[var(--border)] px-5 py-4">
        <h2 className="font-semibold">zAI Content Operator</h2>
        <p className="mt-1 text-xs z-muted">Mọi thao tác dùng quyền của tài khoản hiện tại và được ghi audit log.</p>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto bg-[var(--surface-subtle)] p-5">
        {messages.map((message, index) => (
          <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm ${message.role === "user" ? "bg-[var(--accent)] text-white" : "border border-[var(--border)] bg-[var(--surface-raised)]"}`}>
              {message.content}
            </div>
          </div>
        ))}
        {pending ? <p className="text-xs z-muted">zAI đang xử lý…</p> : null}
      </div>
      {confirmationRequired ? (
        <div className="flex items-center justify-between gap-3 border-t border-red-200 bg-red-50 px-5 py-3 text-sm text-red-900">
          <span>Đây là thao tác xóa. Hãy xác nhận để tiếp tục.</span>
          <div className="flex gap-2">
            <Button onClick={() => setConfirmationRequired(false)}>Hủy</Button>
            <Button variant="primary" disabled={pending} onClick={() => send(true)}>Xác nhận xóa</Button>
          </div>
        </div>
      ) : null}
      <form onSubmit={(event) => { event.preventDefault(); send(); }} className="flex gap-3 border-t border-[var(--border)] p-4">
        <Textarea rows={2} value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ví dụ: Tạo một blog draft tên 'Thông báo mới', slug 'thong-bao-moi'…" disabled={pending} />
        <Button type="submit" variant="primary" disabled={pending || !input.trim()}>Gửi</Button>
      </form>
    </div>
  );
}
