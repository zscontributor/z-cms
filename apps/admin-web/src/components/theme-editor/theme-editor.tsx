"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  LAYOUT_TEMPLATES,
  WIDGET_CATALOG,
  bindingToCollectionQuery,
  collectDocumentCollections,
  collectionNameFor,
  type ContentDto,
  type LayoutDocument,
  type LayoutNode,
  type LayoutTemplateName,
  type LayoutTokens,
  type MenuDto,
} from "@zcmsorg/schemas";
import type { ContentTypeOption } from "@/lib/block-registry";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shell/icon";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n-provider";
import {
  createColumn,
  createRow,
  createSection,
  createWidget,
  duplicateNode,
  insertNode,
  locate,
  moveNode,
  removeNode,
  setBinding,
  setProps,
  setStyle,
  templateTree,
  withTemplate,
} from "@/lib/layout-doc";
import { buildPreviewContext, sampleRows } from "@/lib/preview-context";
import {
  buildThemeDraftAction,
  getThemeDraftStatusAction,
  saveThemeDraftAction,
} from "@/app/actions/theme-draft";
import { previewCollectionsAction } from "@/app/actions/preview";
import type { ThemeDraftDto } from "@/lib/api";
import { Drawer } from "@/components/ui/drawer";
import { Canvas } from "./canvas";
import { Inspector, ThemeTokensFields } from "./inspector";
import { Palette } from "./palette";
import { Layers } from "./layers";
import { TemplateGallery } from "./template-gallery";
import { ChangelogEditor } from "./changelog-editor";
import { PublishPanel } from "./publish-panel";
import { PreviewOverlay } from "./preview-overlay";
import { DEVICE_GLYPH, DEVICE_WIDTH, STUDIO_DEVICES, type StudioDevice } from "./devices";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.3;
const ZOOM_STEP = 0.1;

/**
 * The document plus its undo/redo stacks.
 *
 * The whole `LayoutDocument` is snapshotted on every change rather than recording
 * inverse operations: a tree is small, the edits are coarse (move a section, delete
 * a column and its widgets), and "the document as it was one step ago" is a thing
 * anyone can reason about, where "the inverse of that move" is not. `commit` drops
 * the redo stack — the classic rule that doing something new abandons the branch you
 * undid away from.
 */
interface History {
  past: LayoutDocument[];
  present: LayoutDocument;
  future: LayoutDocument[];
}

type HistoryAction =
  | { type: "commit"; doc: LayoutDocument }
  | { type: "undo" }
  | { type: "redo" };

function historyReducer(state: History, action: HistoryAction): History {
  switch (action.type) {
    case "commit":
      if (action.doc === state.present) return state;
      return { past: [...state.past, state.present], present: action.doc, future: [] };
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { past: [...state.past, state.present], present: next, future: rest };
    }
  }
}

/**
 * The Theme Editor.
 *
 * Three panes: what you can add, what you have drawn, and the knobs of whatever is
 * selected. The document lives in state here and goes to the server whole — see
 * saveThemeDraftAction for why a tree is not patchable.
 *
 * Saving is explicit, not autosave-on-keystroke. A drawing is a design, and a
 * design is a thing people try ideas in; a save on every drag would make Undo the
 * only way back from an experiment — so there is Undo (⌘Z / ⌘⇧Z), and the stack
 * lives entirely in the browser until an explicit Save.
 */
export function ThemeEditor({
  draft,
  contentTypes,
  menus,
  siteName,
  locale,
  canEdit,
  canBuild,
  canPublish,
}: {
  draft: ThemeDraftDto;
  contentTypes: ContentTypeOption[];
  menus: MenuDto[];
  siteName: string;
  locale: string;
  canEdit: boolean;
  /** `theme:sideload` — may install unreviewed theme code by building the design. */
  canBuild: boolean;
  /** `theme:publish` — may put this company's name on a public package. */
  canPublish: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: draft.document,
    future: [],
  }));
  const doc = history.present;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const [template, setTemplate] = useState<LayoutTemplateName>("page");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Studio shell state: which viewport the canvas emulates, how zoomed it is, which
  // left panel is showing, and whether the chrome-less preview overlay is open.
  const [device, setDevice] = useState<StudioDevice>("desktop");
  const [zoom, setZoom] = useState(1);
  const [leftTab, setLeftTab] = useState<"blocks" | "layers" | "templates">("blocks");
  const [previewOpen, setPreviewOpen] = useState(false);
  // The Theme settings drawer (colours, fonts, spacing) — opened by the gear in the
  // header. The tokens used to live in the Inspector's empty state, which meant
  // deselecting everything to reach them; a drawer makes them a deliberate place.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState(draft.version);
  // The last version the server acknowledged. The `version` state is what the field
  // shows while someone is typing; this is what we diff against on blur so an
  // unchanged field is a no-op, and what we revert to when a typed value is rejected.
  const savedVersionRef = useRef(draft.version);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  // The build's own progress, separate from the save transition: `starting` covers
  // the save-then-enqueue click, and `buildStatus` tracks the background job the
  // editor then polls — "building" until the worker writes BUILT or FAILED.
  const [starting, startBuild] = useTransition();
  const [buildStatus, setBuildStatus] = useState<"idle" | "building" | "built" | "failed">(
    draft.status === "BUILDING" ? "building" : "idle",
  );
  // The label of whatever is mid-drag, drawn in a DragOverlay so a floating chip
  // tracks the cursor. Without it dnd-kit only fades the item in place, and a drag
  // with no thing following the pointer reads as broken.
  const [dragLabel, setDragLabel] = useState<string | null>(null);

  const tree = templateTree(doc, template);
  const selected = selectedId ? (locate(tree, selectedId)?.node ?? null) : null;
  // No editing while a build is in flight either: the worker reads the row it is
  // building, and cms-api refuses a save against a BUILDING draft anyway.
  const building = buildStatus === "building";
  const disabled = !canEdit || saving || starting || building;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // A few pixels of slop, or every click on a widget starts a drag and
      // selecting something becomes impossible.
      activationConstraint: { distance: 5 },
    }),
    // The reason a drag library was acceptable here at all: dnd-kit's drags are
    // operable from the keyboard. A canvas that could only be arranged by mouse
    // would be a feature some people simply cannot use.
    useSensor(KeyboardSensor),
  );

  // Real rows keyed by collection name, fetched from the site's own content. Empty
  // until the first fetch lands (and for any list still loading), where the canvas
  // shows sample rows — so the surface is never blank waiting on the network.
  const [realCollections, setRealCollections] = useState<Record<string, ContentDto[]>>({});

  // The document's distinct collection queries, as a stable signature so the fetch
  // effect fires when the bindings change — not on every keystroke of unrelated text.
  const collectionQueries = useMemo(
    () => Object.values(collectDocumentCollections(doc)),
    [doc],
  );
  const querySignature = useMemo(() => JSON.stringify(collectionQueries), [collectionQueries]);

  // Ask cms-api for the REAL rows those bindings resolve to, debounced. The action
  // returns {} on any failure, so the canvas simply keeps its sample rows. Bindings
  // that resolve to the same query share one entry, exactly as on the live site.
  useEffect(() => {
    if (collectionQueries.length === 0) {
      setRealCollections({});
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const rows = await previewCollectionsAction(locale, collectionQueries);
      if (!cancelled) setRealCollections(rows);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // querySignature is the value identity of collectionQueries; depending on it
    // avoids refetching when an unrelated edit produces an equal query set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySignature, locale]);

  /**
   * The canvas draws real widgets, and a post-list reads ctx.collections under the
   * name derived from its own binding. Real rows populate the same keys the live
   * theme uses; a list not yet fetched falls back to sample rows so the surface is
   * never blank — either way it flows through exactly the path the live theme will.
   */
  const ctx = useMemo(() => {
    const base = buildPreviewContext({ siteName, locale, menus });
    const collections: Record<string, ContentDto[]> = {};
    for (const [name, query] of Object.entries(collectDocumentCollections(doc))) {
      // Once a list has been fetched it wins, even when it came back EMPTY — a type
      // with no published content should draw the theme's real empty state, not fake
      // rows. Sample rows are only the placeholder for a list not yet resolved.
      if (name in realCollections) {
        collections[name] = realCollections[name]!;
        continue;
      }
      const label = contentTypes.find((c) => c.key === query.contentType)?.name ?? query.contentType;
      collections[name] = sampleRows(query.limit ?? 6, label);
    }
    return { ...base, collections } as typeof base;
  }, [doc, siteName, locale, menus, contentTypes, realCollections]);

  const mutate = useCallback(
    (next: LayoutNode[]) => {
      dispatch({ type: "commit", doc: withTemplate(doc, template, next) });
      setDirty(true);
      setMessage(null);
    },
    [doc, template],
  );

  const applyTokens = useCallback(
    (tokens: LayoutTokens) => {
      // A token change is an edit like any other, so it joins the undo stack rather
      // than mutating the document behind Undo's back.
      dispatch({ type: "commit", doc: { ...doc, tokens } });
      setDirty(true);
      setMessage(null);
    },
    [doc],
  );

  /** The current column: where a click-to-add widget lands. */
  const currentColumnId = useMemo(() => {
    if (selected?.kind === "column") return selected.id;
    if (selectedId) {
      const found = locate(tree, selectedId);
      if (found?.parent?.kind === "column") return found.parent.id;
    }
    // Nothing selected: the first column of the template, so the very first widget
    // an author adds has somewhere to go without them learning the tree first.
    const firstSection = tree[0];
    const firstRow = firstSection?.children?.[0];
    return firstRow?.children?.[0]?.id ?? null;
  }, [selected, selectedId, tree]);

  function addWidget(widgetType: string) {
    if (!currentColumnId) {
      setMessage(t("themeEditor.errors.noColumn"));
      return;
    }
    const node = createWidget(widgetType);
    const column = locate(tree, currentColumnId);
    mutate(insertNode(tree, currentColumnId, column?.node.children?.length ?? 0, node));
    setSelectedId(node.id);
  }

  /** A human name for what is being dragged, for the floating overlay. */
  const labelForDrag = useCallback(
    (active: { id: string | number; data: { current?: { kind?: string; widgetType?: string } } }) => {
      const data = active.data.current;
      const widgetLabel = (type: string) => {
        const spec = WIDGET_CATALOG.find((s) => s.type === type);
        return spec ? t(spec.labelKey) : type;
      };
      if (data?.kind === "new" && data.widgetType) return widgetLabel(data.widgetType);
      const found = locate(tree, String(active.id));
      if (!found) return null;
      const node = found.node;
      if (node.kind === "widget") return node.widgetType ? widgetLabel(node.widgetType) : "widget";
      return t(`themeEditor.containers.${node.kind}`);
    },
    [t, tree],
  );

  function onDragStart(event: DragStartEvent) {
    setDragLabel(labelForDrag(event.active));
  }

  function onDragEnd(event: DragEndEvent) {
    setDragLabel(null);
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current as { kind?: string; widgetType?: string } | undefined;
    const overId = String(over.id);

    // A palette item is not in the tree yet — dropping it is an insert, not a move.
    if (activeData?.kind === "new" && activeData.widgetType) {
      const column = locate(tree, overId);
      if (column?.node.kind !== "column") return;
      const node = createWidget(activeData.widgetType);
      mutate(insertNode(tree, overId, column.node.children?.length ?? 0, node));
      setSelectedId(node.id);
      return;
    }

    const activeId = String(active.id);
    if (activeId === overId) return;

    // moveNode refuses a drop the containment rule forbids and returns the tree
    // unchanged, so an illegal drop is a no-op here rather than a special case.
    const target = locate(tree, overId);
    if (!target) return;
    const next = moveNode(tree, activeId, overId, target.node.children?.length ?? 0);
    if (next !== tree) mutate(next);
  }

  function moveWithin(id: string, delta: number) {
    const found = locate(tree, id);
    if (!found) return;
    const parentId = found.parent?.id;
    if (!parentId) {
      // A root section: reorder the template's top level directly.
      const index = tree.findIndex((n) => n.id === id);
      const target = index + delta;
      if (target < 0 || target >= tree.length) return;
      const copy = [...tree];
      const [item] = copy.splice(index, 1);
      if (item) copy.splice(target, 0, item);
      mutate(copy);
      return;
    }
    mutate(moveNode(tree, id, parentId, found.index + delta + (delta > 0 ? 1 : 0)));
  }

  /** Delete a block and everything in it; drop the selection if it was that block. */
  const deleteNode = useCallback(
    (id: string) => {
      mutate(removeNode(tree, id));
      if (selectedId === id) setSelectedId(null);
    },
    [mutate, tree, selectedId],
  );

  const undo = useCallback(() => {
    dispatch({ type: "undo" });
    setDirty(true);
    setMessage(null);
  }, []);

  const redo = useCallback(() => {
    dispatch({ type: "redo" });
    setDirty(true);
    setMessage(null);
  }, []);

  /**
   * The editor's keyboard: Delete/Backspace removes the selected block, ⌘/Ctrl+Z
   * undoes, ⌘/Ctrl+Shift+Z (or Ctrl+Y) redoes.
   *
   * The delete keys are ignored while a form control has focus — an author renaming
   * a widget or clearing a text field is pressing Backspace to edit text, not to
   * throw the widget away. On a Mac the key labelled "delete" reports as Backspace,
   * so both must fire, or the one key most people reach for would do nothing.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (disabled) return;
      const mod = event.metaKey || event.ctrlKey;

      if (mod && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        redo();
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        const typing =
          tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
        if (typing || !selectedId) return;
        event.preventDefault();
        deleteNode(selectedId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, selectedId, deleteNode, undo, redo]);

  function save() {
    startSave(async () => {
      const result = await saveThemeDraftAction(draft.id, { document: doc });
      if (result.ok) {
        setDirty(false);
        // Editing a submitted theme reopens its source module as the next patch
        // version. Reflect that immediately, before the author builds and signs.
        savedVersionRef.current = result.data.version;
        setVersion(result.data.version);
        setMessage(t("themeEditor.saved"));
      } else {
        setMessage(result.error);
      }
    });
  }

  /**
   * Persists a hand-typed version.
   *
   * A built version is immutable: once `com.acme.theme@0.1.0` is installed, building
   * the design again with different contents is refused — the only way forward is a
   * new version number. So the version has to be editable here, and it is its own
   * tiny save rather than riding on the document save, because bumping it is exactly
   * the thing an author does when they have NOT touched the drawing.
   *
   * Runs on blur (and Enter): an unchanged field is a no-op, a malformed one is
   * rejected before it reaches the server and the field snaps back to the last value
   * the server accepted, so the header never shows a version that was not saved.
   */
  function commitVersion() {
    const next = version.trim();
    if (next === savedVersionRef.current) return;
    // The same shape parseSemver accepts on the server: three dotted numbers with an
    // optional -pre / +build tail. Caught here so a typo is a sentence now, not a
    // build failure later.
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(next)) {
      setMessage(t("themeEditor.version.invalid"));
      setVersion(savedVersionRef.current);
      return;
    }
    startSave(async () => {
      const result = await saveThemeDraftAction(draft.id, { version: next });
      if (result.ok) {
        savedVersionRef.current = result.data.version;
        setVersion(result.data.version);
        setMessage(t("themeEditor.version.saved"));
      } else {
        setMessage(result.error);
        setVersion(savedVersionRef.current);
      }
    });
  }

  /**
   * Saves the drawing, then builds it — the whole "install what I drew" step in one
   * press, so an author never leaves the canvas to reach the Appearance list.
   *
   * Save FIRST, and only build if it lands: the worker builds the row, not the
   * unsaved edits in this browser, so building a dirty draft would install the
   * PREVIOUS drawing. The server advances the version when the current one is already
   * installed — so a rebuild lands on a fresh number instead of the immutable-version
   * refusal — and hands back the number it will build, which the header then shows.
   */
  function build() {
    startBuild(async () => {
      if (dirty) {
        const saved = await saveThemeDraftAction(draft.id, { document: doc });
        if (!saved.ok) {
          setMessage(saved.error);
          return;
        }
        setDirty(false);
        savedVersionRef.current = saved.data.version;
        setVersion(saved.data.version);
      }

      const started = await buildThemeDraftAction(draft.id);
      if (!started.ok) {
        setMessage(started.error);
        return;
      }
      savedVersionRef.current = started.data.version;
      setVersion(started.data.version);
      setBuildStatus("building");
      setMessage(t("themeEditor.build.started", { version: started.data.version }));
    });
  }

  // While a build runs, poll for its outcome — nothing pushes a background job's
  // result to the browser. On BUILT, refresh so the freshly staged checksum reaches
  // the Publish panel (Sign turns on); on FAILED, show the reason, already a friendly
  // sentence. The interval tears down the moment the status settles.
  useEffect(() => {
    if (buildStatus !== "building") return;
    let cancelled = false;
    async function poll() {
      const res = await getThemeDraftStatusAction(draft.id);
      if (cancelled || !res.ok) return;
      if (res.data.status === "BUILT") {
        setBuildStatus("built");
        setMessage(t("themeEditor.build.done", { version: res.data.version }));
        router.refresh();
      } else if (res.data.status === "FAILED") {
        setBuildStatus("failed");
        setMessage(res.data.buildError ?? t("themeEditor.build.failed"));
      }
    }
    const id = setInterval(poll, 3000);
    poll();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [buildStatus, draft.id, router, t]);

  // Any edit invalidates a finished build: the staged package no longer matches the
  // drawing, so drop the BUILT/FAILED note (the same reason PublishPanel hides Sign
  // while dirty). Guarded so it does not fire mid-build.
  useEffect(() => {
    if (dirty && (buildStatus === "built" || buildStatus === "failed")) {
      setBuildStatus("idle");
    }
  }, [dirty, buildStatus]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragLabel(null)}
    >
      <div className="flex h-[100dvh] w-screen flex-col bg-neutral-950">
        {/* The chrome is dark (studio look) while the canvas paper stays light and
            readable, so `dark` is scoped to each chrome panel — header and the two
            asides — not the whole tree. Tailwind v4 dark = a `.dark` ancestor. */}
        <header className="dark flex items-center justify-between gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-2 text-neutral-100">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold">{draft.name}</h1>
            <div className="flex items-center gap-1.5 text-xs text-neutral-500">
              <code>{draft.key}</code>
              <span aria-hidden>·</span>
              <label className="flex items-center gap-0.5">
                <span aria-hidden className="select-none">
                  v
                </span>
                <input
                  aria-label={t("themeEditor.version.label")}
                  value={version}
                  onChange={(event) => setVersion(event.target.value)}
                  onBlur={commitVersion}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  disabled={disabled}
                  size={8}
                  className="w-16 rounded border border-neutral-200 bg-transparent px-1 py-0.5 font-mono text-xs text-neutral-700 focus:border-brand-500 focus:outline-none disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300"
                />
              </label>
            </div>
          </div>

          {/* Centre: undo/redo · device · zoom — the studio's viewport controls. */}
          <div className="flex items-center gap-1.5">
            <div className="flex items-center rounded-lg border border-neutral-700 bg-neutral-950 p-0.5">
              <Button
                size="sm"
                variant="ghost"
                className="px-2"
                disabled={disabled || !canUndo}
                onClick={undo}
                aria-label={t("themeEditor.actions.undo")}
                title={t("themeEditor.actions.undo")}
              >
                <Icon name="undo" size={16} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="px-2"
                disabled={disabled || !canRedo}
                onClick={redo}
                aria-label={t("themeEditor.actions.redo")}
                title={t("themeEditor.actions.redo")}
              >
                <Icon name="redo" size={16} />
              </Button>
            </div>

            <div
              className="flex items-center rounded-lg border border-neutral-700 bg-neutral-950 p-0.5"
              role="group"
              aria-label={t("themeEditor.studio.device")}
            >
              {STUDIO_DEVICES.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={device === d}
                  aria-label={t(`themeEditor.studio.${d}`)}
                  title={t(`themeEditor.studio.${d}`)}
                  onClick={() => setDevice(d)}
                  className={cn(
                    "h-7 w-8 rounded text-sm leading-none",
                    device === d
                      ? "bg-brand-500/20 text-brand-300"
                      : "text-neutral-400 hover:text-neutral-100",
                  )}
                >
                  {DEVICE_GLYPH[d]}
                </button>
              ))}
            </div>

            <div className="flex items-center rounded-lg border border-neutral-700 bg-neutral-950 p-0.5">
              <button
                type="button"
                className="h-7 w-7 rounded text-neutral-400 hover:text-neutral-100"
                aria-label={t("themeEditor.studio.zoomOut")}
                onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))}
              >
                −
              </button>
              <button
                type="button"
                className="w-12 text-xs tabular-nums text-neutral-300"
                aria-label={t("themeEditor.studio.zoomReset")}
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="h-7 w-7 rounded text-neutral-400 hover:text-neutral-100"
                aria-label={t("themeEditor.studio.zoomIn")}
                onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))}
              >
                ＋
              </button>
            </div>
          </div>

          {/* Right: status + preview + settings + save + build. */}
          <div className="flex items-center gap-2">
            {message ? (
              <span className="max-w-[16rem] truncate text-xs text-neutral-400">{message}</span>
            ) : null}
            {dirty ? <span className="text-xs text-amber-400">{t("themeEditor.unsaved")}</span> : null}
            <Button
              size="sm"
              variant="ghost"
              className="gap-1 px-2"
              disabled={tree.length === 0}
              onClick={() => setPreviewOpen(true)}
            >
              <Icon name="eye" size={16} />
              {t("themeEditor.studio.preview")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="px-2"
              onClick={() => setSettingsOpen(true)}
              aria-label={t("themeEditor.actions.settings")}
              title={t("themeEditor.actions.settings")}
            >
              <Icon name="settings" size={16} />
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled || !dirty} onClick={save}>
              {saving ? t("themeEditor.actions.saving") : t("themeEditor.actions.save")}
            </Button>
            {canBuild ? (
              // Save-and-build in one press. Disabled only while a build is actually
              // running — a dirty draft is fine, `build()` saves it first.
              <Button size="sm" disabled={!canEdit || saving || starting || building} onClick={build}>
                {starting || building
                  ? t("themeEditor.actions.building")
                  : t("themeEditor.actions.build")}
              </Button>
            ) : null}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="dark flex w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900 text-neutral-200">
            <div
              className="flex gap-1 border-b border-neutral-800 px-2 pt-2"
              role="tablist"
              aria-label={t("themeEditor.studio.leftPanel")}
            >
              {(["blocks", "layers", "templates"] as const).map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={leftTab === name}
                  onClick={() => setLeftTab(name)}
                  className={cn(
                    "flex-1 rounded-t px-2 py-1.5 text-xs font-medium",
                    leftTab === name
                      ? "border-b-2 border-brand-500 text-brand-300"
                      : "text-neutral-400 hover:text-neutral-100",
                  )}
                >
                  {t(`themeEditor.studio.${name}`)}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {leftTab === "blocks" ? (
                <Palette onAdd={addWidget} disabled={disabled} />
              ) : leftTab === "layers" ? (
                <div className="p-2">
                  <Layers
                    tree={tree}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onMoveWithin={moveWithin}
                    disabled={disabled}
                  />
                </div>
              ) : (
                <TemplateGallery
                  disabled={disabled}
                  onInsert={(nodes) => {
                    mutate([...tree, ...nodes]);
                    if (nodes[0]) setSelectedId(nodes[0].id);
                  }}
                />
              )}
            </div>
          </aside>

          <main className="flex min-w-0 flex-1 flex-col">
            {/* Template strip: which of the four trees is on the canvas. */}
            <div
              className="dark flex items-center gap-1 border-b border-neutral-800 bg-neutral-900 px-3 py-1.5"
              role="tablist"
              aria-label={t("themeEditor.templates.label")}
            >
              {LAYOUT_TEMPLATES.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={template === name}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs",
                    template === name
                      ? "bg-brand-500 text-white"
                      : "text-neutral-400 hover:bg-neutral-800",
                  )}
                  onClick={() => {
                    setTemplate(name);
                    setSelectedId(null);
                  }}
                >
                  {t(`themeEditor.templates.${name}`)}
                </button>
              ))}
            </div>

            {/* The workspace: a dark, dotted surface holding the device-framed paper.
                Width follows the device; zoom scales the paper from the top-centre. */}
            <div
              className="min-h-0 flex-1 overflow-auto p-6"
              style={{
                background:
                  "radial-gradient(circle at 1px 1px, rgba(255,255,255,.10) 1px, transparent 0) 0 0 / 18px 18px, #1f2430",
              }}
            >
              <div
                className="mx-auto bg-white shadow-2xl transition-[width]"
                style={{
                  width: DEVICE_WIDTH[device] ?? "100%",
                  maxWidth: "100%",
                  transform: zoom === 1 ? undefined : `scale(${zoom})`,
                  transformOrigin: "top center",
                }}
              >
                {/* The template a person never drew has no tree — `page` is the only
                    required one, and the rest fall back to it at render time. */}
                <Canvas
                  tree={tree}
                  ctx={ctx}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onAddSection={() => mutate([...tree, createSection()])}
                  onAddRow={(sectionId) => {
                    const section = locate(tree, sectionId);
                    mutate(insertNode(tree, sectionId, section?.node.children?.length ?? 0, createRow()));
                  }}
                  onAddColumn={(rowId) => {
                    const row = locate(tree, rowId);
                    mutate(insertNode(tree, rowId, row?.node.children?.length ?? 0, createColumn(6)));
                  }}
                  onMoveWithin={moveWithin}
                  onDuplicate={(id) => mutate(duplicateNode(tree, id))}
                  // Deleting the block the inspector was showing leaves it pointing at
                  // nothing; deleteNode falls back to the theme's own tokens.
                  onDelete={deleteNode}
                  disabled={disabled}
                />
              </div>
            </div>
          </main>

          {/* One scroll column beside the design: Inspector, then Release notes and
              the Publish flow — the last steps of the same job. */}
          <aside className="dark flex w-80 shrink-0 flex-col overflow-y-auto border-l border-neutral-800 bg-neutral-900 text-neutral-200">
            <Inspector
              doc={doc}
              node={selected}
              contentTypes={contentTypes}
              disabled={disabled}
              onProps={(props) => selectedId && mutate(setProps(tree, selectedId, props))}
              onBinding={(binding) => selectedId && mutate(setBinding(tree, selectedId, binding))}
              onStyle={(style) => selectedId && mutate(setStyle(tree, selectedId, style))}
              onDelete={() => selectedId && deleteNode(selectedId)}
              onDuplicate={() => selectedId && mutate(duplicateNode(tree, selectedId))}
            />
            <ChangelogEditor draftId={draft.id} changelog={draft.changelog} />
            <PublishPanel
              draftId={draft.id}
              draftKey={draft.key}
              payloadChecksum={dirty ? null : draft.payloadChecksum}
              canPublish={canPublish}
            />
          </aside>
        </div>
      </div>

      {/* Theme settings, one gear-click away. The tokens are the theme's own
          settingsSchema, so editing them IS editing the document — every change goes
          through applyTokens onto the undo stack, and the drawer needs no Save of its
          own. Disabled with the rest of the canvas while a build is in flight. */}
      <Drawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={t("themeEditor.inspector.themeTitle")}
        description={t("themeEditor.inspector.themeHint")}
        width="sm"
      >
        <ThemeTokensFields tokens={doc.tokens} onChange={applyTokens} disabled={disabled} />
      </Drawer>

      {/* Preview: the drawn template rendered chrome-less, at the chosen device
          width, from the same context the canvas uses. Sample data for now — M3
          swaps in the site's real rows. */}
      {previewOpen ? (
        <PreviewOverlay
          nodes={tree}
          tokens={doc.tokens}
          ctx={ctx}
          device={device}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}

      {/* The thing you are dragging, following the cursor. A plain labelled chip
          rather than a clone of the widget: the drop TARGET is what needs to read
          clearly (the canvas highlights it), and a full-size ghost would only get
          in the way of seeing it. */}
      <DragOverlay dropAnimation={null}>
        {dragLabel ? (
          <div className="pointer-events-none flex items-center gap-1 rounded border border-brand-500 bg-white px-2.5 py-1.5 text-xs font-medium text-brand-700 shadow-lg dark:bg-neutral-900 dark:text-brand-300">
            <span aria-hidden>⠿</span>
            {dragLabel}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
