"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-provider";
import { Icon } from "./icon";

export function ThemeToggle() {
  const t = useT();
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  // The class is already correct (the inline bootstrap script set it); this only
  // syncs React's copy of the truth after hydration.
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
    setMounted(true);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("zcms-theme", next ? "dark" : "light");
    } catch {
      // Private mode — the preference simply will not persist.
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-label={dark ? t("admin.themeToggle.toLight") : t("admin.themeToggle.toDark")}
      title={dark ? t("admin.themeToggle.light") : t("admin.themeToggle.dark")}
      className="size-9 px-0"
    >
      {mounted && dark ? <Icon name="sun" /> : <Icon name="moon" />}
    </Button>
  );
}
