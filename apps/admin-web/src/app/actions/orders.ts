"use server";

import { revalidatePath } from "next/cache";
import type { CommerceSettingsDto, OrderDto } from "@zcmsorg/schemas";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";

export type OrderActionResult = { ok: true; message: string } | { ok: false; error: string };

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

/** Move an order to a new status. FormData-shaped so a row/detail button drives it. */
export async function updateOrderStatusAction(formData: FormData): Promise<OrderActionResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "order:manage")) return { ok: false, error: t("commerce.detail.saveFailed") };

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");

  try {
    await apiFetch<OrderDto>(`/orders/${id}/status`, { method: "PATCH", body: { status } });
    revalidatePath("/orders");
    revalidatePath(`/orders/${id}`);
    return { ok: true, message: t("commerce.detail.saved") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("commerce.detail.saveFailed")) };
  }
}

/** Save the storefront configuration. */
export async function saveCommerceSettingsAction(formData: FormData): Promise<OrderActionResult> {
  const t = await getT();
  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "commerce:configure")) return { ok: false, error: t("commerce.settings.readOnly") };

  const threshold = String(formData.get("freeShippingThreshold") ?? "").trim();

  const body = {
    enabled: formData.get("enabled") === "on",
    currency: String(formData.get("currency") ?? "USD").trim(),
    codEnabled: formData.get("codEnabled") === "on",
    shippingFlatFee: Number(formData.get("shippingFlatFee") ?? 0) || 0,
    freeShippingThreshold: threshold === "" ? null : Number(threshold) || 0,
    storeName: String(formData.get("storeName") ?? "").trim(),
    storeEmail: String(formData.get("storeEmail") ?? "").trim(),
  };

  try {
    await apiFetch<CommerceSettingsDto>("/settings/commerce", { method: "PUT", body });
    revalidatePath("/settings/commerce");
    return { ok: true, message: t("commerce.settings.saved") };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("commerce.settings.saveFailed")) };
  }
}
