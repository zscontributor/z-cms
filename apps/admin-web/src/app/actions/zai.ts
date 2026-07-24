"use server";

import { apiFetch, can, getSession } from "@/lib/api";

export type ZaiAdminMessage = { role: "user" | "assistant"; content: string };

export async function zaiAdminChatAction(
  messages: ZaiAdminMessage[],
  confirmDestructive = false,
): Promise<
  | { ok: true; answer: string; confirmationRequired?: boolean }
  | { ok: false; error: string }
> {
  const user = await getSession();
  if (!user) return { ok: false, error: "Phiên đăng nhập đã hết hạn." };
  if (!can(user, "content:read")) return { ok: false, error: "Bạn không có quyền đọc nội dung." };

  try {
    const result = await apiFetch<{ answer: string; confirmationRequired?: boolean }>(
      "/ai/admin/chat",
      { method: "POST", body: { messages, confirmDestructive } },
    );
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "zAI không thể xử lý yêu cầu." };
  }
}
