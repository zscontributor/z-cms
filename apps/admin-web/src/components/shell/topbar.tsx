import type { SessionUser, SiteDto } from "@zcmsorg/schemas";
import { SiteSwitcher } from "./site-switcher";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

export function Topbar({
  user,
  sites,
  currentSiteId,
}: {
  user: SessionUser;
  sites: SiteDto[];
  currentSiteId: string | null;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-raised)]/85 px-4 backdrop-blur md:px-6">
      <SiteSwitcher sites={sites} currentSiteId={currentSiteId} />
      <div className="flex-1" />
      <ThemeToggle />
      <UserMenu user={user} />
    </header>
  );
}
