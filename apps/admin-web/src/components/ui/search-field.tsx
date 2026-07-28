"use client";

import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";

/**
 * The magnifier-prefixed search box shared by the package-management screens
 * (Appearance, Plugins, Marketplace). A thin wrapper over `z-input` so every
 * catalogue filters the same way and looks the same doing it.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
        <Icon name="search" className="h-4 w-4" />
      </span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="z-input w-full pl-8"
      />
    </div>
  );
}
