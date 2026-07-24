"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

export function CopyUrlButton({ url }: { url: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // clipboard API needs a secure context; fall back to a selection copy.
      const field = document.createElement("textarea");
      field.value = url;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      document.execCommand("copy");
      document.body.removeChild(field);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => void copy()}
      title={t("media.copyUrl.title")}
      className="w-full justify-start"
    >
      <Icon name={copied ? "check" : "copy"} size={18} />
      {copied ? t("media.copyUrl.copied") : t("media.copyUrl.action")}
    </Button>
  );
}
