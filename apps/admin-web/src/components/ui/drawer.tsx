"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

export type DrawerWidth = "sm" | "md" | "lg";

const WIDTHS: Record<DrawerWidth, string> = {
  sm: "sm:w-[22rem]",
  md: "sm:w-[30rem]",
  lg: "sm:w-[40rem]",
};

/**
 * A right-side sliding panel for creating a record or viewing detail without
 * leaving the page. Built on the native <dialog>, exactly like {@link Dialog}:
 * it inherits the top layer, focus trap and Escape-to-close for free. The only
 * difference is placement — pinned flush to the right edge, full viewport height.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "md",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: DrawerWidth;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
      // Content is always mounted, so React's `autoFocus` (mount-only) can't fire
      // on open. Honour an opt-in `data-autofocus` instead — otherwise showModal's
      // own steps leave focus on the first focusable (the close button).
      node.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
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
        // `z-drawer` carries the slide/fade transition (globals.css). Pin to the
        // right edge, full height — `m-0 ml-auto` overrides the UA margin:auto
        // that would otherwise centre the dialog. The backdrop is styled in CSS
        // too, so it can fade in step with the panel.
        "z-drawer m-0 ml-auto h-dvh max-h-none w-full border-l border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl",
        WIDTHS[width],
        className,
      )}
    >
      {/*
       * Content stays mounted regardless of `open` so the exit transition slides a
       * fully-drawn panel out instead of flickering to empty. A closed <dialog> is
       * `display:none`, so this costs nothing visually.
       */}
      <div className="flex h-full flex-col">
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
    </dialog>
  );
}
