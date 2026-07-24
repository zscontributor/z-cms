"use client";

import { useTransition } from "react";
import { seedActiveThemeDemoAction } from "@/app/actions/theme";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-provider";

export function SeedDemoButton({ seeded }: { seeded: boolean }) {
  const t = useT();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant={seeded ? "secondary" : "primary"}
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          const result = await seedActiveThemeDemoAction();
          if (!result.ok) {
            window.alert(result.error);
            return;
          }
          window.alert(result.message);
        });
      }}
    >
      {pending
        ? t("appearance.demo.seeding")
        : seeded
          ? t("appearance.demo.reseed")
          : t("appearance.demo.seed")}
    </Button>
  );
}
