"use client";

import { useFormStatus } from "react-dom";
import { useT } from "@/lib/i18n-provider";
import { Button, type ButtonProps } from "./button";

/**
 * A submit button that disables itself while its enclosing form's action is in
 * flight. Must live *inside* the <form> — useFormStatus reads the nearest one.
 */
export function SubmitButton({
  children,
  pendingLabel,
  ...props
}: ButtonProps & { pendingLabel?: string }) {
  const t = useT();
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {pending ? (pendingLabel ?? t("common.working")) : children}
    </Button>
  );
}
