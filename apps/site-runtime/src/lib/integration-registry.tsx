import type { ReactNode } from "react";
import type { CommercePublicConfig, RenderIntegration } from "@zcmsorg/schemas";
import type { IntegrationSlot } from "@zcmsorg/theme-sdk";
import { AiAssistant } from "@/components/ai-assistant";
import { Storefront } from "@/components/storefront";

interface AiAssistantData {
  name: string;
  welcomeMessage: string;
}

function commerceConfig(integration: RenderIntegration): CommercePublicConfig | null {
  const data = integration.data as Partial<CommercePublicConfig> | null;
  if (!data || typeof data.currency !== "string") {
    console.warn("[integrations] Invalid public data for commerce.checkout; storefront skipped.");
    return null;
  }
  return {
    enabled: data.enabled !== false,
    currency: data.currency,
    codEnabled: data.codEnabled !== false,
    shippingFlatFee: typeof data.shippingFlatFee === "number" ? data.shippingFlatFee : 0,
    freeShippingThreshold:
      typeof data.freeShippingThreshold === "number" ? data.freeShippingThreshold : null,
  };
}

function aiAssistantData(integration: RenderIntegration): AiAssistantData | null {
  const data = integration.data as Record<string, unknown> | null;
  if (!data || typeof data.name !== "string" || typeof data.welcomeMessage !== "string") {
    console.warn("[integrations] Invalid public data for ai.assistant; widget skipped.");
    return null;
  }
  return { name: data.name, welcomeMessage: data.welcomeMessage };
}

/**
 * Runtime-owned integration UI. Themes choose the position; plugins never ship
 * browser JavaScript or gain access to Next.js/React internals.
 */
export function renderIntegrationSlot(
  slot: IntegrationSlot,
  integrations: Record<string, RenderIntegration>,
  locale = "en",
): ReactNode {
  if (slot === "floating") {
    const assistant = integrations["ai.assistant"];
    if (!assistant) return null;
    const data = aiAssistantData(assistant);
    if (!data) return null;
    return <AiAssistant name={data.name} welcomeMessage={data.welcomeMessage} />;
  }

  if (slot === "commerce") {
    const commerce = integrations["commerce.checkout"];
    if (!commerce) return null;
    const config = commerceConfig(commerce);
    if (!config || !config.enabled) return null;
    return <Storefront config={config} locale={locale} />;
  }

  return null;
}
