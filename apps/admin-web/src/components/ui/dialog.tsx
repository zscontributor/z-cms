"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

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
        "z-card m-auto w-[min(32rem,calc(100vw-2rem))] p-0 text-[var(--text)] shadow-2xl backdrop:bg-black/50",
        className,
      )}
    >
      {open ? (
        <div className="flex flex-col">
          <header className="border-b border-[var(--border)] px-4 py-3">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 text-xs z-muted">{description}</p> : null}
          </header>
          {children ? <div className="px-4 py-4">{children}</div> : null}
          {footer ? (
            <footer className="flex justify-end gap-2 border-t border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}
