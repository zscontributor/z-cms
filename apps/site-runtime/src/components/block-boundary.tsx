"use client";

import { Component, type ReactNode } from "react";

/**
 * One bad block must never take down the page.
 *
 * Blocks render arbitrary editor JSON through theme code we do not control, so a
 * throw is a question of when, not if. Each block is isolated behind this
 * boundary: in production the broken one disappears and the other twelve blocks
 * on the page still render; in development it says so, loudly, where the block
 * would have been.
 */
export class BlockBoundary extends Component<
  { blockType: string; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(`[blocks] "${this.props.blockType}" failed to render:`, error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    if (process.env.NODE_ENV === "production") return null;

    return (
      <div
        role="alert"
        className="mx-auto my-4 max-w-3xl rounded-lg border-2 border-dashed border-red-400 bg-red-50 p-4 text-sm text-red-900"
      >
        <p className="font-semibold">
          Block “{this.props.blockType}” threw while rendering.
        </p>
        <p className="mt-1 font-mono text-xs">{this.state.error.message}</p>
        <p className="mt-2 text-xs text-red-700">
          This message is development-only; in production the block is skipped.
        </p>
      </div>
    );
  }
}
