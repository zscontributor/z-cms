"use client";

import { useEffect, useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import Link from "@tiptap/extension-link";
import { ResizableImage, type ImageAlign } from "./image-extension";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/field";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";
import { MediaPickerDialog } from "./media-picker";

/**
 * What an author writes a post with. It edits HTML, because that is what the
 * `core/richtext` block and the `richtext` field already store and what a theme
 * renders — the editor is a nicer surface over the same string, not a new format.
 *
 * The HTML it produces is bounded by the extensions registered below: nothing
 * here can emit a <script>, a style attribute or an onclick. Content written
 * before this editor existed is a different matter — ProseMirror drops whatever
 * its schema does not know when it loads a document, so markup this editor
 * cannot represent survives only as long as nobody opens it visually. "Source"
 * stays reachable for exactly that case.
 */
export function RichTextEditor({
  value,
  onChange,
  disabled,
  id,
  placeholder,
  minHeight = "16rem",
}: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
  minHeight?: string;
}) {
  const t = useT();
  const [source, setSource] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkHref, setLinkHref] = useState("");
  const [mediaOpen, setMediaOpen] = useState(false);

  const editor = useEditor({
    // The admin renders on the server first; ProseMirror must not touch the DOM
    // until it is on the client, or React hydration mismatches.
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        // Registered separately below so the link options live in one place;
        // leaving the StarterKit copy on would duplicate the extension name.
        link: false,
        heading: { levels: [2, 3, 4] },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto", "tel"],
      }),
      ResizableImage.configure({ inline: false }),
      Placeholder.configure({
        placeholder: placeholder ?? t("content.richtext.placeholder"),
      }),
    ],
    content: value || "",
    editorProps: {
      attributes: {
        class: "z-prose z-richtext-content",
        ...(id ? { id } : {}),
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(instance.isEmpty ? "" : instance.getHTML());
    },
  });

  // The value can change from outside the editor: a block being duplicated, a
  // save that normalises the HTML, or the source textarea below.
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (current === value) return;
    editor.commands.setContent(value || "", { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  if (source) {
    return (
      <div className="rounded-md border border-[var(--border-strong)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1.5">
          <span className="text-[11px] z-muted">{t("content.richtext.sourceHint")}</span>
          <Button size="sm" variant="ghost" onClick={() => setSource(false)}>
            {t("content.richtext.visual")}
          </Button>
        </div>
        <Textarea
          id={id}
          rows={14}
          spellCheck={false}
          disabled={disabled}
          className="rounded-none border-0 font-mono text-xs focus-visible:ring-0"
          value={value}
          placeholder={t("content.blocks.htmlPlaceholder")}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-[var(--border-strong)] focus-within:border-brand-500">
      <Toolbar
        editor={editor}
        disabled={disabled}
        onLink={() => {
          setLinkHref((editor?.getAttributes("link").href as string | undefined) ?? "");
          setLinkOpen(true);
        }}
        onImage={() => setMediaOpen(true)}
        onSource={() => setSource(true)}
      />

      <EditorContent
        editor={editor}
        className="z-scroll-thin overflow-y-auto px-3 py-2"
        style={{ minHeight, maxHeight: "42rem" }}
      />

      {editor && !disabled ? <ImageMenu editor={editor} /> : null}

      <Dialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title={t("content.richtext.linkTitle")}
        description={t("content.richtext.linkHint")}
        footer={
          <>
            <Button onClick={() => setLinkOpen(false)}>{t("common.cancel")}</Button>
            {editor?.isActive("link") ? (
              <Button
                onClick={() => {
                  editor.chain().focus().extendMarkRange("link").unsetLink().run();
                  setLinkOpen(false);
                }}
              >
                {t("content.richtext.linkRemove")}
              </Button>
            ) : null}
            <Button
              variant="primary"
              disabled={!linkHref.trim()}
              onClick={() => {
                const href = linkHref.trim();
                if (!href || !editor) return;
                editor
                  .chain()
                  .focus()
                  .extendMarkRange("link")
                  .setLink({ href })
                  .run();
                setLinkOpen(false);
              }}
            >
              {t("content.richtext.linkApply")}
            </Button>
          </>
        }
      >
        <Input
          value={linkHref}
          autoFocus
          placeholder="https://…"
          onChange={(event) => setLinkHref(event.target.value)}
        />
      </Dialog>

      <MediaPickerDialog
        open={mediaOpen}
        onClose={() => setMediaOpen(false)}
        multiple
        imagesOnly
        onSelect={(list) => {
          if (editor && list.length > 0) {
            // One chain, one transaction: a batch of images lands as a single
            // undo step, and each setImage inserts after the previous one.
            let chain = editor.chain().focus();
            for (const media of list) {
              chain = chain.setImage({ src: media.url, alt: media.alt ?? media.filename });
            }
            chain.run();
          }
          setMediaOpen(false);
        }}
      />
    </div>
  );
}

/**
 * Toolbar state has to come from `useEditorState`: a ProseMirror transaction is
 * not React state, so without a selector subscription the buttons would never
 * light up as the caret moves through bold text.
 */
function Toolbar({
  editor,
  disabled,
  onLink,
  onImage,
  onSource,
}: {
  editor: Editor | null;
  disabled?: boolean;
  onLink: () => void;
  onImage: () => void;
  onSource: () => void;
}) {
  const t = useT();

  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
      bold: instance?.isActive("bold") ?? false,
      italic: instance?.isActive("italic") ?? false,
      strike: instance?.isActive("strike") ?? false,
      code: instance?.isActive("code") ?? false,
      h2: instance?.isActive("heading", { level: 2 }) ?? false,
      h3: instance?.isActive("heading", { level: 3 }) ?? false,
      bulletList: instance?.isActive("bulletList") ?? false,
      orderedList: instance?.isActive("orderedList") ?? false,
      blockquote: instance?.isActive("blockquote") ?? false,
      codeBlock: instance?.isActive("codeBlock") ?? false,
      link: instance?.isActive("link") ?? false,
      canUndo: instance?.can().undo() ?? false,
      canRedo: instance?.can().redo() ?? false,
    }),
  });

  const off = disabled || !editor;

  return (
    <div
      role="toolbar"
      aria-label={t("content.richtext.toolbar")}
      className="flex flex-wrap items-center gap-0.5 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-1"
    >
      <ToolButton
        icon="bold"
        label={t("content.richtext.bold")}
        active={state?.bold}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      />
      <ToolButton
        icon="italic"
        label={t("content.richtext.italic")}
        active={state?.italic}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      />
      <ToolButton
        icon="strikethrough"
        label={t("content.richtext.strike")}
        active={state?.strike}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleStrike().run()}
      />
      <ToolButton
        icon="code"
        label={t("content.richtext.code")}
        active={state?.code}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleCode().run()}
      />

      <Separator />

      <ToolButton
        icon="h2"
        label={t("content.richtext.h2")}
        active={state?.h2}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <ToolButton
        icon="h3"
        label={t("content.richtext.h3")}
        active={state?.h3}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <ToolButton
        icon="bulletList"
        label={t("content.richtext.bulletList")}
        active={state?.bulletList}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      />
      <ToolButton
        icon="orderedList"
        label={t("content.richtext.orderedList")}
        active={state?.orderedList}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      />
      <ToolButton
        icon="quote"
        label={t("content.richtext.blockquote")}
        active={state?.blockquote}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
      />
      <ToolButton
        icon="codeBlock"
        label={t("content.richtext.codeBlock")}
        active={state?.codeBlock}
        disabled={off}
        onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
      />
      <ToolButton
        icon="rule"
        label={t("content.richtext.horizontalRule")}
        disabled={off}
        onClick={() => editor?.chain().focus().setHorizontalRule().run()}
      />

      <Separator />

      <ToolButton
        icon="link"
        label={t("content.richtext.link")}
        active={state?.link}
        disabled={off}
        onClick={onLink}
      />
      <ToolButton
        icon="image"
        label={t("content.richtext.image")}
        disabled={off}
        onClick={onImage}
      />
      <ToolButton
        icon="eraser"
        label={t("content.richtext.clearFormat")}
        disabled={off}
        onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}
      />

      <Separator />

      <ToolButton
        icon="undo"
        label={t("content.richtext.undo")}
        disabled={off || !state?.canUndo}
        onClick={() => editor?.chain().focus().undo().run()}
      />
      <ToolButton
        icon="redo"
        label={t("content.richtext.redo")}
        disabled={off || !state?.canRedo}
        onClick={() => editor?.chain().focus().redo().run()}
      />

      <button
        type="button"
        onClick={onSource}
        className="ml-auto rounded px-2 py-1 text-[11px] z-muted hover:bg-[var(--surface-raised)] hover:text-[var(--text)]"
      >
        {t("content.richtext.source")}
      </button>
    </div>
  );
}

const WIDTHS = ["25%", "50%", "75%", "100%"] as const;

const ALIGNMENTS: ReadonlyArray<{ align: ImageAlign; icon: string; labelKey: string }> = [
  { align: "left", icon: "alignLeft", labelKey: "content.richtext.imageLeft" },
  { align: "center", icon: "alignCenter", labelKey: "content.richtext.imageCenter" },
  { align: "right", icon: "alignRight", labelKey: "content.richtext.imageRight" },
];

/**
 * Selecting an image (a click is enough — ProseMirror turns it into a node
 * selection) floats this over it. Alignment and width are the two things an
 * author actually reaches for; anything more belongs in the media library.
 */
function ImageMenu({ editor }: { editor: Editor }) {
  const t = useT();

  const state = useEditorState({
    editor,
    selector: ({ editor: instance }) => {
      const attributes = instance.getAttributes("image");
      return {
        align: (attributes.align ?? null) as ImageAlign | null,
        width: (attributes.width ?? null) as string | null,
      };
    },
  });

  function update(attributes: { align?: ImageAlign | null; width?: string | null }) {
    editor.chain().focus().updateAttributes("image", attributes).run();
  }

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: instance }) => instance.isActive("image")}
      options={{ placement: "top", offset: 8 }}
      className="z-card flex items-center gap-0.5 p-1 shadow-lg"
    >
      {ALIGNMENTS.map(({ align, icon, labelKey }) => (
        <ToolButton
          key={align}
          icon={icon}
          label={t(labelKey)}
          active={state?.align === align}
          // Clicking the active alignment clears it, which hands the image back
          // to whatever the theme's own layout does with it.
          onClick={() => update({ align: state?.align === align ? null : align })}
        />
      ))}

      <Separator />

      {WIDTHS.map((width) => (
        <button
          key={width}
          type="button"
          title={t("content.richtext.imageWidth", { width })}
          onClick={() => update({ width })}
          className={cn(
            "rounded px-1.5 py-1 text-[11px] tabular-nums hover:bg-[var(--surface-sunken)]",
            state?.width === width && "bg-brand-500/14 font-medium text-brand-600 dark:text-brand-300",
          )}
        >
          {width}
        </button>
      ))}
      <button
        type="button"
        onClick={() => update({ width: null })}
        className={cn(
          "rounded px-1.5 py-1 text-[11px] hover:bg-[var(--surface-sunken)]",
          !state?.width && "bg-brand-500/14 font-medium text-brand-600 dark:text-brand-300",
        )}
      >
        {t("content.richtext.imageWidthOriginal")}
      </button>

      <Separator />

      <ToolButton
        icon="trash"
        label={t("content.richtext.imageRemove")}
        onClick={() => editor.chain().focus().deleteSelection().run()}
      />
    </BubbleMenu>
  );
}

function ToolButton({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active ?? false}
      className={cn(
        "flex size-7 items-center justify-center rounded",
        "hover:bg-[var(--surface-raised)] disabled:cursor-not-allowed disabled:opacity-40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40",
        active && "bg-brand-500/14 text-brand-600 dark:text-brand-300",
      )}
    >
      <Icon name={icon} size={18} weight={active ? "bold" : "regular"} />
    </button>
  );
}

function Separator() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-[var(--border)]" />;
}
