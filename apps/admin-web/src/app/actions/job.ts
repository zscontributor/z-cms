"use server";

import { revalidatePath } from "next/cache";
import { ApiError, apiFetch, can, getSession } from "@/lib/api";
import { getT } from "@/lib/locale";

export type JobActionResult = { ok: true; message: string } | { ok: false; error: string };

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

/** Puts the job back on the queue. If it fails again it lands back here. */
export async function retryFailedJobAction(id: string, name: string): Promise<JobActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "settings:update")) {
    return { ok: false, error: t("admin.jobs.actions.denied") };
  }

  try {
    await apiFetch<{ ok: true }>(`/jobs/failed/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    });
    revalidatePath("/jobs");
    return { ok: true, message: t("admin.jobs.actions.retried", { name }) };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.jobs.actions.retryFailed")) };
  }
}

/**
 * Deletes the job. This is a decision that the work will never be done — there
 * is no archive behind it and no way back, which is why the UI asks first.
 */
export async function discardFailedJobAction(id: string, name: string): Promise<JobActionResult> {
  const t = await getT();

  const user = await getSession();
  if (!user) return { ok: false, error: t("auth.session.expired") };
  if (!can(user, "settings:update")) {
    return { ok: false, error: t("admin.jobs.actions.denied") };
  }

  try {
    await apiFetch<void>(`/jobs/failed/${encodeURIComponent(id)}`, { method: "DELETE" });
    revalidatePath("/jobs");
    return { ok: true, message: t("admin.jobs.actions.discarded", { name }) };
  } catch (error) {
    return { ok: false, error: toMessage(error, t("admin.jobs.actions.discardFailed")) };
  }
}
