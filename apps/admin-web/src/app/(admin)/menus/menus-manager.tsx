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
import { Field, Input, Select } from "@/components/ui/field";
import { useT } from "@/lib/i18n-provider";

export interface PageOption {
  path: string;
  title: string;
}

/** The editable shape. `id` is a client-only handle for React keys + dnd sorting. */
interface EditItem {
  id: string;
  label: string;
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
    url: item.url,
    target: item.target || "_self",
    children: (item.children ?? []).map(toEdit),
  };
}

function toInput(item: EditItem): MenuItemInput {
  return {
    label: item.label,
    url: item.url,
    target: item.target,
    ...(item.children.length ? { children: item.children.map(toInput) } : {}),
  };
}

const emptyItem = (): EditItem => ({ id: uid(), label: "", url: "", target: "_self", children: [] });

const URL_LIST_ID = "zsoft-menu-urls";

export function MenusManager({
  menus,
  pages,
  canManage,
}: {
  menus: MenuDto[];
  pages: PageOption[];
  canManage: boolean;
}) {
  const t = useT();
  const [extra, setExtra] = useState<MenuDto[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");

  const existingKeys = new Set(menus.map((m) => m.key));
  const all = [...menus, ...extra.filter((m) => !existingKeys.has(m.key))];

  const addMenu = () => {
    const key = newKey.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!key || existingKeys.has(key) || extra.some((m) => m.key === key)) return;
    setExtra((prev) => [...prev, { key, name: newName.trim() || key, items: [] }]);
    setNewKey("");
    setNewName("");
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

      {all.length === 0 ? (
        <p className="rounded-md border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-sm z-muted">
          {t("admin.menus.empty")}
        </p>
      ) : (
        all.map((menu) => <MenuCard key={menu.key} menu={menu} canManage={canManage} />)
      )}

      {canManage ? (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface-raised)] p-4">
          <p className="mb-2 text-sm font-medium">{t("admin.menus.create")}</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("admin.menus.newLocation")} hint={t("admin.menus.newLocationHint")}>
              <Input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="primary"
                className="w-40"
              />
            </Field>
            <Field label={t("admin.menus.name")}>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Primary menu"
                className="w-56"
              />
            </Field>
            <Button variant="secondary" onClick={addMenu} disabled={!newKey.trim()}>
              {t("admin.menus.create")}
            </Button>
          </div>
        </div>
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

function MenuCard({ menu, canManage }: { menu: MenuDto; canManage: boolean }) {
  const t = useT();
  const [name, setName] = useState(menu.name);
  const [items, setItems] = useState<EditItem[]>(menu.items.map(toEdit));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

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
              <Button size="sm" variant="danger" onClick={() => removeTop(i)} aria-label={t("admin.menus.remove")}>
                ✕
              </Button>
            </div>
          </div>

          {it.children.length > 0 ? (
            <SortableContext items={it.children.map((c) => c.id)} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-2 border-l border-[var(--border)] pl-3">
                {it.children.map((c, j) => (
                  <SortableRow
                    key={c.id}
                    id={c.id}
                    disabled={!canManage}
                    handleLabel={t("admin.menus.label")}
                    className="flex flex-wrap items-center gap-2"
                  >
                    {fields(
                      c,
                      (v) => setChild(i, j, { label: v }),
                      (v) => setChild(i, j, { url: v }),
                      (v) => setChild(i, j, { target: v }),
                    )}
                    <Button size="sm" variant="danger" onClick={() => removeChild(i, j)} aria-label={t("admin.menus.remove")}>
                      ✕
                    </Button>
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
    </section>
  );
}
