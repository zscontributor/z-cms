import type {
  ComponentPropsWithRef,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

export function Label({ className, children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn("mb-1.5 block text-xs font-medium text-[var(--text)]", className)} {...props}>
      {children}
    </label>
  );
}

/**
 * `ComponentPropsWithRef` rather than `InputHTMLAttributes`: React 19 passes `ref`
 * as an ordinary prop, and the login form needs one to put the cursor back in the
 * code field after a wrong code. Without it the ref would type-error at the call
 * site while working perfectly at runtime, which is the worst of both.
 */
export function Input({ className, ...props }: ComponentPropsWithRef<"input">) {
  return <input className={cn("z-input", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("z-input resize-y", className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn("z-input pr-8 appearance-none bg-no-repeat", className)} {...props}>
      {children}
    </select>
  );
}

export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 rounded border-[var(--border-strong)] accent-brand-500",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="ml-0.5 text-brand-500">*</span> : null}
      </Label>
      {children}
      {hint ? <p className="mt-1 text-[11px] leading-4 z-muted">{hint}</p> : null}
    </div>
  );
}
