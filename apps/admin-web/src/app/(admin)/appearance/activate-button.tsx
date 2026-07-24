"use client";

import { useState, useTransition } from "react";
import { activateThemeAction } from "@/app/actions/theme";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-provider";

export function ActivateButton({ themeKey, name }: { themeKey: string; name: string }) {
  const t = useT();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span className="text-[11px] text-red-600 dark:text-red-400">{error}</span>
      ) : null}
      <Button
        size="sm"
        variant="primary"
        disabled={pending}
        onClick={() => {
          setError(null);
          const formData = new FormData();
          formData.set("key", themeKey);
          startTransition(async () => {
            try {
              await activateThemeAction(formData);
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : t("appearance.errors.activateFailed", { name }),
              );
            }
          });
        }}
      >
        {pending ? t("appearance.activating") : t("appearance.activate")}
      </Button>
    </div>
  );
}
