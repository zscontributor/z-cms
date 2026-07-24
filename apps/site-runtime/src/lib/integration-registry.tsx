import type { ReactNode } from "react";
import type { RenderIntegration } from "@zcmsorg/schemas";
import type { IntegrationSlot } from "@zcmsorg/theme-sdk";
import { AiAssistant } from "@/components/ai-assistant";

interface AiAssistantData {
  name: string;
  welcomeMessage: string;
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
): ReactNode {
  if (slot !== "floating") return null;

  const assistant = integrations["ai.assistant"];
  if (!assistant) return null;
  const data = aiAssistantData(assistant);
  if (!data) return null;

  return <AiAssistant name={data.name} welcomeMessage={data.welcomeMessage} />;
}
