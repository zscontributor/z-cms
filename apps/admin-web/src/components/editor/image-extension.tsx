"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Image from "@tiptap/extension-image";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { cn } from "@/lib/cn";

export type ImageAlign = "left" | "center" | "right";

/**
 * The alignment and the width have to survive *outside* the admin: a post's HTML
 * is handed to whichever theme renders it, and a theme is a separate package
 * that knows nothing about our class names. So the geometry travels as an inline
 * style — the one thing every renderer already honours — with `data-align` kept
 * alongside purely so the editor can read the choice back on load.
 *
 * The width is a percentage, never pixels: the same post is read on a phone, and
 * an image pinned at 780px would blow out of a 380px column. A drag therefore
 * resolves against the width of the text column, not against the pointer.
 */
const ALIGN_STYLE: Record<ImageAlign, string> = {
  left: "display:block;margin-left:0;margin-right:auto;",
  center: "display:block;margin-left:auto;margin-right:auto;",
  right: "display:block;margin-left:auto;margin-right:0;",
};

const MIN_PERCENT = 10;

export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),

      width: {
        default: null,
        parseHTML: (element) => element.style.width || element.getAttribute("width") || null,
        renderHTML: (attributes) => {
          const width = attributes.width as string | null;
          if (!width) return {};
          return { style: `width:${width};height:auto;` };
        },
      },

      align: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-align"),
        renderHTML: (attributes) => {
          const align = attributes.align as ImageAlign | null;
          if (!align) return {};
          return { "data-align": align, style: ALIGN_STYLE[align] };
        },
      },
    };
  },

  // Only the *editing* surface gets the node view; renderHTML above is still
  // what gets stored and what a theme receives, so the handles never leak out.
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});

type Corner = "nw" | "ne" | "sw" | "se";

const CORNERS: ReadonlyArray<{ corner: Corner; position: string; cursor: string }> = [
  { corner: "nw", position: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "nwse-resize" },
  { corner: "ne", position: "right-0 top-0 translate-x-1/2 -translate-y-1/2", cursor: "nesw-resize" },
  { corner: "sw", position: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2", cursor: "nesw-resize" },
  { corner: "se", position: "bottom-0 right-0 translate-x-1/2 translate-y-1/2", cursor: "nwse-resize" },
];

function ImageNodeView({ node, updateAttributes, selected, editor }: ReactNodeViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [dragging, setDragging] = useState(false);

  const width = (node.attrs.width as string | null) ?? null;
  const align = (node.attrs.align as ImageAlign | null) ?? null;
  const editable = editor.isEditable;

  function startResize(event: ReactPointerEvent<HTMLSpanElement>, corner: Corner) {
    // Without this the browser starts a native image drag and ProseMirror thinks
    // the node is being moved, not resized.
    event.preventDefault();
    event.stopPropagation();

    const wrapper = wrapperRef.current;
    const image = imageRef.current;
    if (!wrapper || !image) return;

    const columnWidth = wrapper.clientWidth;
    if (columnWidth === 0) return;

    const startX = event.clientX;
    const startWidth = image.clientWidth;
    // The west handles grow the image as the pointer moves left.
    const direction = corner === "nw" || corner === "sw" ? -1 : 1;

    setDragging(true);

    const onMove = (move: PointerEvent) => {
      const next = startWidth + direction * (move.clientX - startX);
      const percent = Math.round((next / columnWidth) * 100);
      updateAttributes({
        width: `${Math.min(100, Math.max(MIN_PERCENT, percent))}%`,
      });
    };

    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      as="div"
      className="z-image-node"
      style={{ textAlign: align ?? undefined }}
    >
      <span
        className="relative inline-block max-w-full align-bottom"
        style={{ width: width ?? undefined }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imageRef}
          src={node.attrs.src as string}
          alt={(node.attrs.alt as string | null) ?? ""}
          title={(node.attrs.title as string | null) ?? undefined}
          draggable={false}
          className={cn(
            "block h-auto max-w-full rounded-md",
            width ? "w-full" : "w-auto",
            selected && "outline outline-2 outline-brand-500",
          )}
        />

        {selected && editable
          ? CORNERS.map(({ corner, position, cursor }) => (
              <span
                key={corner}
                role="presentation"
                onPointerDown={(event) => startResize(event, corner)}
                style={{ cursor }}
                className={cn(
                  "absolute size-3 rounded-full border-2 border-white bg-brand-500 shadow",
                  "dark:border-[var(--surface-raised)]",
                  position,
                )}
              />
            ))
          : null}

        {dragging && width ? (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white">
            {width}
          </span>
        ) : null}
      </span>
    </NodeViewWrapper>
  );
}
