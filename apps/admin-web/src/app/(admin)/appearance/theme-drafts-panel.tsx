"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ThemeDraftSummaryDto } from "@/lib/api";
import {
  buildThemeDraftAction,
  createThemeDraftAction,
  deleteThemeDraftAction,
} from "@/app/actions/theme-draft";
import { Button, LinkButton } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";

/**
 * The designs a person has drawn on this site, and the door into the editor.
 *
 * Lives on the Appearance page rather than in its own nav item: a drawn theme is a
 * theme, and the question "what does this site look like" should have one answer
 * on one screen. What it is NOT is the installed list — a design renders nowhere
 * until it is built — so it sits in its own section with its own heading.
 */
export function ThemeDraftsPanel({
  drafts,
  canAuthor,
  canBuild,
}: {
  drafts: ThemeDraftSummaryDto[];
  canAuthor: boolean;
  /**
   * `theme:sideload`, not `theme:author`. Building installs unreviewed code onto
   * this server — the same act as uploading a theme file, and the same permission.
   */
  canBuild: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function create(formData: FormData) {
    const name = String(formData.get("name") ?? "").trim();
    const key = String(formData.get("key") ?? "").trim();
    if (!name || !key) return;

    start(async () => {
      const result = await createThemeDraftAction({ name, key });
      if (result.ok) {
        // Straight into the editor: the reason somebody pressed "New design" was
        // to draw, not to look at a row appear in a list.
        router.push(`/theme-editor/${result.data.id}`);
      } else {
        setError(result.error);
      }
    });
  }

  function remove(id: string) {
    start(async () => {
      const result = await deleteThemeDraftAction(id);
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  function build(id: string) {
    start(async () => {
      const result = await buildThemeDraftAction(id);
      // The build runs in the background; refresh shows BUILDING, and the operator
      // comes back to BUILT or FAILED. No polling — a design is not a thing anybody
      // watches a spinner for.
      if (result.ok) router.refresh();
      else setError(result.error);
    });
  }

  return (
    <section className="mb-5">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t("appearance.drafts.heading")}</h2>
          <p className="mt-0.5 text-[11px] z-muted">{t("appearance.drafts.hint")}</p>
        </div>
        {canAuthor && !creating ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            {t("themeEditor.actions.create")}
          </Button>
        ) : null}
      </div>

      {error ? <p className="mb-2 text-xs text-red-600">{error}</p> : null}

      {creating ? (
        <form action={create} className="z-card mb-3 grid gap-3 p-4 sm:grid-cols-3">
          <Field label={t("appearance.drafts.name")}>
            <Input name="name" required placeholder="Acme Shop" />
          </Field>
          <Field label={t("appearance.drafts.key")} hint={t("appearance.drafts.keyHint")}>
            <Input name="key" required placeholder="com.acme.theme.shop" />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? t("themeEditor.actions.saving") : t("themeEditor.actions.create")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {drafts.length === 0 ? (
        <p className="z-card p-6 text-center text-xs z-muted">{t("appearance.drafts.empty")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {drafts.map((draft) => (
            <article key={draft.id} className="z-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{draft.name}</h3>
                  <code className="block truncate text-[11px] z-muted">{draft.key}</code>
                </div>
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] uppercase dark:bg-neutral-800">
                  {t(`appearance.drafts.status.${draft.status}`)}
                </span>
              </div>

              {/* The reason a build failed belongs on the card. Somebody who pressed
                  Build and walked away needs to find out here, not in a log. */}
              {draft.buildError ? (
                <p className="mt-2 line-clamp-3 text-[11px] text-red-600">{draft.buildError}</p>
              ) : null}

              <div className="mt-3 flex gap-2">
                <LinkButton href={`/theme-editor/${draft.id}`} size="sm">
                  {t("themeEditor.actions.open")}
                </LinkButton>
                {canBuild ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending || draft.status === "BUILDING"}
                    onClick={() => build(draft.id)}
                  >
                    {draft.status === "BUILDING"
                      ? t("appearance.drafts.status.BUILDING")
                      : t("themeEditor.actions.build")}
                  </Button>
                ) : null}
                {canAuthor ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => remove(draft.id)}
                  >
                    {t("themeEditor.actions.delete")}
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
