"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

/**
 * Built on the native <dialog>: it gives us the top layer, focus trapping and
 * Escape-to-close for free, which is most of what a dialog library sells.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Clicking the backdrop targets the dialog element itself.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "z-card m-auto max-h-[min(44rem,calc(100dvh-2rem))] w-[min(32rem,calc(100vw-2rem))] p-0 text-[var(--text)] shadow-2xl backdrop:bg-black/50",
        className,
      )}
    >
      {open ? (
        // Cap the dialog height and let only the body scroll: the header and
        // footer stay pinned so the title and actions are always in reach.
        <div className="flex max-h-[inherit] flex-col">
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{title}</h2>
              {description ? <p className="mt-0.5 text-xs z-muted">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 z-muted transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          </header>
          {children ? <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div> : null}
          {footer ? (
            <footer className="flex shrink-0 justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
