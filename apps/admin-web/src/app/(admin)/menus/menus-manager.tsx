"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MenuDto, MenuItemDto } from "@zcmsorg/schemas";
import { saveMenuAction, type MenuItemInput } from "@/app/actions/menu";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input, Select } from "@/components/ui/field";
import { Flag } from "@/components/shell/flag";
import { Icon } from "@/components/shell/icon";
import { useT } from "@/lib/i18n-provider";

export interface PageOption {
  path: string;
  title: string;
}

/** The editable shape. `id` is a client-only handle for React keys + dnd sorting. */
interface EditItem {
  id: string;
  label: string;
  /** Per-locale label overrides, keyed by locale. Blank entries are dropped on save. */
  labels: Record<string, string>;
  url: string;
  target: string;
  children: EditItem[];
}

let seq = 0;
const uid = () => `mi_${seq++}`;

function toEdit(item: MenuItemDto): EditItem {
  return {
    id: uid(),
    label: item.label,
    labels: { ...(item.labels ?? {}) },
    url: item.url,
    target: item.target || "_self",
    children: (item.children ?? []).map(toEdit),
  };
}

/** Only the locale labels the admin actually filled in reach the server. */
function cleanLabels(labels: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [locale, value] of Object.entries(labels)) {
    if (value.trim()) out[locale] = value.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function toInput(item: EditItem): MenuItemInput {
  const labels = cleanLabels(item.labels);
  return {
    label: item.label,
    ...(labels ? { labels } : {}),
    url: item.url,
    target: item.target,
    ...(item.children.length ? { children: item.children.map(toInput) } : {}),
  };
}

const emptyItem = (): EditItem => ({
  id: uid(),
  label: "",
  labels: {},
  url: "",
  target: "_self",
  children: [],
});

const URL_LIST_ID = "zsoft-menu-urls";

/** Preferred column order for the well-known theme locations; others follow, sorted. */
const MENU_ORDER = ["primary", "footer"];

export function MenusManager({
  menus,
  pages,
  localeOptions,
  canManage,
}: {
  menus: MenuDto[];
  pages: PageOption[];
  /** Non-default locales the site publishes in; each gets a per-item label input. */
  localeOptions: string[];
  canManage: boolean;
}) {
  const t = useT();
  const [extra, setExtra] = useState<MenuDto[]>([]);
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");

  const existingKeys = new Set(menus.map((m) => m.key));
  // Primary reads first (left column), footer next (right column), then any custom
  // location alphabetically. The API lists menus by key, which alone would put
  // "footer" before "primary".
  const rank = (key: string) => {
    const i = MENU_ORDER.indexOf(key);
    return i === -1 ? MENU_ORDER.length : i;
  };
  const all = [...menus, ...extra.filter((m) => !existingKeys.has(m.key))].sort(
    (a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key),
  );

  const normalizedKey = newKey.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const keyTaken = !!normalizedKey && (existingKeys.has(normalizedKey) || extra.some((m) => m.key === normalizedKey));

  const closeCreate = () => {
    setCreating(false);
    setNewKey("");
    setNewName("");
  };

  const addMenu = () => {
    if (!normalizedKey || keyTaken) return;
    setExtra((prev) => [...prev, { key: normalizedKey, name: newName.trim() || normalizedKey, items: [] }]);
    closeCreate();
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Shared URL suggestions: the site's published pages. Free text still works. */}
      <datalist id={URL_LIST_ID}>
        {pages.map((p) => (
          <option key={p.path} value={p.path}>
            {p.title}
          </option>
        ))}
      </datalist>

      {canManage ? (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" className="h-4 w-4" />
            {t("admin.menus.create")}
          </Button>
        </div>
      ) : null}

      {all.length === 0 ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-sm z-muted">
          {t("admin.menus.empty")}
        </p>
      ) : (
        // Two columns from lg up (primary left, footer right), one column below it.
        // `items-start` keeps each card its own height rather than stretching the
        // shorter one to match its neighbour.
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
          {all.map((menu) => (
            <MenuCard key={menu.key} menu={menu} localeOptions={localeOptions} canManage={canManage} />
          ))}
        </div>
      )}

      {canManage ? (
        <Drawer
          open={creating}
          onClose={closeCreate}
          title={t("admin.menus.create")}
          description={t("admin.menus.createHint")}
          footer={
            <>
              <Button variant="secondary" onClick={closeCreate}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" onClick={addMenu} disabled={!normalizedKey || keyTaken}>
                {t("admin.menus.create")}
              </Button>
            </>
          }
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              addMenu();
            }}
          >
            <Field
              label={t("admin.menus.newLocation")}
              hint={keyTaken ? t("admin.menus.keyTaken") : t("admin.menus.newLocationHint")}
            >
              <Input
                data-autofocus
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="primary"
              />
            </Field>
            <Field label={t("admin.menus.name")}>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Primary menu"
              />
            </Field>
            {/* Lets Enter submit the form even though the visible submit lives in the footer. */}
            <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}

/** A draggable row wrapper. The whole row is the drag target via a grip handle. */
function SortableRow({
  id,
  className,
  handleLabel,
  disabled,
  children,
}: {
  id: string;
  className?: string;
  handleLabel: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <li ref={setNodeRef} style={style} className={className}>
      {disabled ? null : (
        <button
          type="button"
          className="shrink-0 cursor-grab touch-none px-1 text-[var(--text-muted)] hover:text-[var(--text)] active:cursor-grabbing"
          aria-label={handleLabel}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
      )}
      {children}
    </li>
  );
}

/**
 * The per-locale label overrides for one item, behind a disclosure so a single-
 * language site (localeOptions empty) sees nothing, and a multilingual one keeps
 * the row uncluttered until the admin opens it. An override is optional: left
 * blank, cms-api falls back to the translated page title (internal links) or the
 * base label (everything else).
 */
function ItemTranslations({
  item,
  locales,
  onLabel,
  canManage,
}: {
  item: EditItem;
  locales: string[];
  onLabel: (locale: string, value: string) => void;
  canManage: boolean;
}) {
  const t = useT();
  const filled = locales.filter((l) => item.labels[l]?.trim()).length;
  const [open, setOpen] = useState(filled > 0);

  if (locales.length === 0) return null;

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs z-muted hover:text-[var(--text)]"
        aria-expanded={open}
      >
        <Icon name="language" className="h-3.5 w-3.5" />
        {t("admin.menus.translations")}
        {filled > 0 ? ` (${filled})` : ""}
      </button>
      {open ? (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5 rounded-md bg-[var(--surface-sunken)] p-2">
          {locales.map((loc) => (
            <label key={loc} className="flex items-center gap-1.5">
              {/* Flag as the visual anchor, code as the name beside it — a flag
                  alone never identifies a language (see shell/flag.tsx). */}
              <span className="flex w-11 shrink-0 items-center gap-1">
                <Flag locale={loc} />
                <span className="font-mono text-[10px] uppercase z-muted">{loc}</span>
              </span>
              <Input
                aria-label={`${t("admin.menus.label")} (${loc})`}
                value={item.labels[loc] ?? ""}
                onChange={(e) => onLabel(loc, e.target.value)}
                placeholder={item.label || t("admin.menus.label")}
                disabled={!canManage}
                className="w-44"
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MenuCard({
  menu,
  localeOptions,
  canManage,
}: {
  menu: MenuDto;
  localeOptions: string[];
  canManage: boolean;
}) {
  const t = useT();
  const [name, setName] = useState(menu.name);
  const [items, setItems] = useState<EditItem[]>(menu.items.map(toEdit));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  // The menu item queued for removal, awaiting confirmation. `j` present means a
  // sub-item under top item `i`; absent means the top item itself.
  const [removeTarget, setRemoveTarget] = useState<{ i: number; j?: number; label: string } | null>(
    null,
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // --- immutable tree edits (2 levels: top items + their children) -----------
  const setTop = (i: number, patch: Partial<EditItem>) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const setChild = (i: number, j: number, patch: Partial<EditItem>) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i
          ? { ...it, children: it.children.map((c, cj) => (cj === j ? { ...c, ...patch } : c)) }
          : it,
      ),
    );

  // Per-locale label edits merge into the item's `labels` map, leaving the base
  // label and everything else untouched.
  const setTopLabel = (i: number, locale: string, value: string) =>
    setTop(i, { labels: { ...items[i]!.labels, [locale]: value } });

  const setChildLabel = (i: number, j: number, locale: string, value: string) =>
    setChild(i, j, { labels: { ...items[i]!.children[j]!.labels, [locale]: value } });

  const addTop = () => setItems((prev) => [...prev, emptyItem()]);
  const removeTop = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));
  const addChild = (i: number) =>
    setItems((prev) =>
      prev.map((it, idx) => (idx === i ? { ...it, children: [...it.children, emptyItem()] } : it)),
    );
  const removeChild = (i: number, j: number) =>
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i ? { ...it, children: it.children.filter((_, cj) => cj !== j) } : it,
      ),
    );

  // Remove is confirmed through a modal so a mis-click doesn't silently drop a
  // link (and its whole submenu). The target carries its own indices so the
  // handler stays correct even if the list re-renders behind the dialog.
  const confirmRemove = () => {
    if (!removeTarget) return;
    const { i, j } = removeTarget;
    if (j === undefined) removeTop(i);
    else removeChild(i, j);
    setRemoveTarget(null);
  };

  // Drag reorder: within the top list, or within one parent's children. Cross-list
  // drags are ignored — moving in/out of a submenu is what Add sub-item / Remove do.
  const onDragEnd = (e: DragEndEvent) => {
    if (!canManage) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const locate = (id: string) => {
      const ti = items.findIndex((it) => it.id === id);
      if (ti >= 0) return { kind: "top" as const, index: ti };
      for (let i = 0; i < items.length; i++) {
        const cj = items[i]!.children.findIndex((c) => c.id === id);
        if (cj >= 0) return { kind: "child" as const, parent: i, index: cj };
      }
      return null;
    };
    const a = locate(String(active.id));
    const o = locate(String(over.id));
    if (!a || !o) return;
    if (a.kind === "top" && o.kind === "top") {
      setItems((prev) => arrayMove(prev, a.index, o.index));
    } else if (a.kind === "child" && o.kind === "child" && a.parent === o.parent) {
      setItems((prev) =>
        prev.map((it, idx) =>
          idx === a.parent ? { ...it, children: arrayMove(it.children, a.index, o.index) } : it,
        ),
      );
    }
  };

  const save = () => {
    setMessage(null);
    startTransition(async () => {
      const clean = items
        .filter((it) => it.label.trim() || it.url.trim())
        .map((it) => ({
          ...it,
          children: it.children.filter((c) => c.label.trim() || c.url.trim()),
        }));
      const result = await saveMenuAction({ key: menu.key, name, items: clean.map(toInput) });
      setMessage(result.ok ? { ok: true, text: result.message } : { ok: false, text: result.error });
    });
  };

  const fields = (
    it: EditItem,
    onLabel: (v: string) => void,
    onUrl: (v: string) => void,
    onTarget: (v: string) => void,
  ) => (
    <>
      <Input
        aria-label={t("admin.menus.label")}
        value={it.label}
        onChange={(e) => onLabel(e.target.value)}
        placeholder={t("admin.menus.label")}
        disabled={!canManage}
        className="flex-1 min-w-32"
      />
      <Input
        aria-label={t("admin.menus.url")}
        list={URL_LIST_ID}
        value={it.url}
        onChange={(e) => onUrl(e.target.value)}
        placeholder="/about"
        disabled={!canManage}
        className="flex-1 min-w-32"
      />
      <Select
        aria-label={t("admin.menus.target")}
        value={it.target}
        onChange={(e) => onTarget(e.target.value)}
        disabled={!canManage}
        className="w-32"
      >
        <option value="_self">{t("admin.menus.targetSelf")}</option>
        <option value="_blank">{t("admin.menus.targetBlank")}</option>
      </Select>
    </>
  );

  const topList = (
    <ul className="flex flex-col gap-2">
      {items.map((it, i) => (
        <SortableRow
          key={it.id}
          id={it.id}
          disabled={!canManage}
          handleLabel={t("admin.menus.label")}
          className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-2"
        >
          <div className="flex flex-1 flex-wrap items-center gap-2">
            {fields(
              it,
              (v) => setTop(i, { label: v }),
              (v) => setTop(i, { url: v }),
              (v) => setTop(i, { target: v }),
            )}
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => addChild(i)}>
                {t("admin.menus.addChild")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => setRemoveTarget({ i, label: it.label })}
                aria-label={t("admin.menus.remove")}
              >
                ✕
              </Button>
            </div>
          </div>

          <ItemTranslations
            item={it}
            locales={localeOptions}
            canManage={canManage}
            onLabel={(loc, v) => setTopLabel(i, loc, v)}
          />

          {it.children.length > 0 ? (
            <SortableContext items={it.children.map((c) => c.id)} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-2 border-l border-[var(--border)] pl-3">
                {it.children.map((c, j) => (
                  <SortableRow
                    key={c.id}
                    id={c.id}
                    disabled={!canManage}
                    handleLabel={t("admin.menus.label")}
                    className="flex items-start gap-2"
                  >
                    <div className="flex flex-1 flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        {fields(
                          c,
                          (v) => setChild(i, j, { label: v }),
                          (v) => setChild(i, j, { url: v }),
                          (v) => setChild(i, j, { target: v }),
                        )}
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setRemoveTarget({ i, j, label: c.label })}
                          aria-label={t("admin.menus.remove")}
                        >
                          ✕
                        </Button>
                      </div>
                      <ItemTranslations
                        item={c}
                        locales={localeOptions}
                        canManage={canManage}
                        onLabel={(loc, v) => setChildLabel(i, j, loc, v)}
                      />
                    </div>
                  </SortableRow>
                ))}
              </ul>
            </SortableContext>
          ) : null}
        </SortableRow>
      ))}
    </ul>
  );

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-4">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-end gap-3">
          <span className="rounded bg-[var(--surface-sunken)] px-2 py-1 font-mono text-xs z-muted">
            {menu.key}
          </span>
          <Field label={t("admin.menus.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} className="w-56" />
          </Field>
        </div>
        {canManage ? (
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending ? t("admin.menus.saving") : t("admin.menus.save")}
          </Button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="py-2 text-xs z-muted">{t("admin.menus.itemsEmpty")}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((it) => it.id)} strategy={verticalListSortingStrategy}>
            {topList}
          </SortableContext>
        </DndContext>
      )}

      {canManage ? (
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" variant="secondary" onClick={addTop}>
            {t("admin.menus.addItem")}
          </Button>
          <span className="text-xs z-muted">{t("admin.menus.urlHint")}</span>
        </div>
      ) : null}

      {message ? (
        <p
          className={`mt-2 text-xs ${message.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
        >
          {message.text}
        </p>
      ) : null}

      <Dialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={t("admin.menus.removeConfirmTitle")}
        description={
          removeTarget?.label.trim()
            ? t("admin.menus.removeConfirmBody", { label: removeTarget.label.trim() })
            : t("admin.menus.removeConfirmBodyUnnamed")
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoveTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              className="bg-red-600 hover:bg-red-700 active:bg-red-800"
              onClick={confirmRemove}
            >
              {t("admin.menus.remove")}
            </Button>
          </>
        }
      />
    </section>
  );
}
