import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700 border border-transparent shadow-sm",
  secondary:
    "bg-[var(--surface-raised)] text-[var(--text)] border border-[var(--border-strong)] hover:bg-[var(--surface-sunken)]",
  ghost:
    "bg-transparent text-[var(--text-muted)] border border-transparent hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]",
  danger:
    "bg-transparent text-red-600 dark:text-red-400 border border-[var(--border-strong)] hover:bg-red-50 dark:hover:bg-red-950/40 hover:border-red-300 dark:hover:border-red-800",
  // `danger` opens the door; `destructive` is the button that walks through it.
  // Solid red is reserved for the confirmation of something that cannot be
  // undone — a revoke, a discard — so that it never appears in a row of
  // ordinary actions and never looks like one.
  destructive:
    "bg-red-600 text-white hover:bg-red-700 active:bg-red-800 border border-transparent shadow-sm focus-visible:ring-red-500/40",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(
    "inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
    "disabled:opacity-50 disabled:pointer-events-none",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, size, className)} {...props} />;
}

export interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Same skin, but a real <a> — navigation must stay a link. */
export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
  ...props
}: LinkButtonProps) {
  return (
    <Link href={href} className={buttonClasses(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}
