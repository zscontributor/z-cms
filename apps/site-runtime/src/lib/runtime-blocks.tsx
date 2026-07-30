import type { ReactNode } from "react";
import type { BlockProps } from "@zcmsorg/theme-sdk";
import { FormIsland } from "@/components/form-island";
import { formMessages } from "@/lib/form-messages";

/**
 * Block types the RUNTIME owns, rendered on every theme regardless of whether the
 * theme bridges them. `renderBlocks` consults this after the theme's own block map
 * (theme wins on a clash), so a platform block like `core/form` needs no
 * cooperation from any theme — the whole point of the forms layer.
 *
 * Kept deliberately tiny: only blocks that are genuinely the platform's, not a
 * theme's to style. `core/form` renders a plugin-declared form as an interactive
 * island by id; anything the id does not resolve to renders nothing.
 */
type RuntimeBlock = (props: BlockProps) => ReactNode;

function FormBlock({ props, ctx }: BlockProps): ReactNode {
  const formId = typeof props.formId === "string" ? props.formId : "";
  const def = formId ? ctx.forms[formId] : undefined;
  if (!def) {
    // Unknown/inactive form: nothing in production. In dev, say why — an author who
    // picked a form whose plugin is not active would otherwise see a silent gap.
    if (process.env.NODE_ENV !== "production") {
      return (
        <div role="alert" style={{ padding: 12, border: "1px dashed #f59e0b", color: "#92400e", borderRadius: 8 }}>
          core/form: no active plugin provides a form with id “{formId || "(missing formId)"}”.
        </div>
      );
    }
    return null;
  }
  // Resolved here, on the server: the island is handed one language, never a
  // catalogue, and never a list of languages baked into a component.
  return <FormIsland def={def} messages={formMessages(ctx.locale)} />;
}

export const runtimeCoreBlocks: Record<string, RuntimeBlock> = {
  "core/form": FormBlock,
};
