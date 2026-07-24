"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Wordmark } from "@/components/brand";
import { cn } from "@/lib/cn";
import { Icon } from "./icon";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function Sidebar({
  groups,
  siteName,
  siteLabel,
}: {
  groups: NavGroup[];
  siteName: string;
  siteLabel: string;
}) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface-raised)] md:flex">
      <div className="flex h-14 items-center border-b border-[var(--border)] px-4">
        <Link href="/" className="min-w-0">
          <Wordmark />
        </Link>
      </div>

      <nav className="z-scroll-thin flex-1 overflow-y-auto px-3 py-4">
        {groups.map((group) => (
          <div key={group.label} className="mb-5 last:mb-0">
            <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider z-muted">
              {group.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                        active
                          ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                          : "z-muted hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]",
                      )}
                    >
                      <Icon
                        name={item.icon}
                        className={active ? "text-brand-500" : "opacity-70"}
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-[var(--border)] px-4 py-3">
        <p className="text-[10px] uppercase tracking-wider z-muted">{siteLabel}</p>
        <p className="truncate text-xs font-medium">{siteName}</p>
      </div>
    </aside>
  );
}
