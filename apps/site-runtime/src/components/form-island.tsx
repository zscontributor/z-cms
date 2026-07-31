"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { checkFormField, formPickSlots } from "@zcmsorg/schemas";
import type { FormFieldErrorCode, PublicFormDef, PublicFormField } from "@zcmsorg/schemas";
import { PICK_EVENT, readPicks, writePicks, type FormPick } from "@/lib/form-pick";
import type { FormMessages } from "@/lib/form-messages";

/**
 * The runtime-owned renderer for a plugin-declared public form.
 *
 * A theme cannot ship this — it renders on the server and carries no client JS —
 * so, exactly like the AI assistant and the storefront, the runtime mounts the
 * interactive UI. Given a form's browser-safe definition (from `payload.forms`,
 * projected by cms-api), it renders the inputs, validates with the SAME rules the
 * server enforces (`buildFormSchema`), and submits to `/api/forms/:id/submit` — no
 * navigation, so a failed send keeps what the visitor typed; only a real success
 * resets the form. The plugin wrote none of this: it declared fields and a handler.
 */

/**
 * The words this form says, resolved for one visitor by the SERVER.
 *
 * There used to be an `{ en, vi, ja }` dictionary here — a platform component with
 * a hardcoded list of languages in it, so a site in a fourth language read English
 * from Z-CMS while its theme spoke the visitor's own. The catalogue is
 * `@zcmsorg/i18n`'s (`site.form.*`) and the resolving happens in
 * `lib/form-messages.ts`; a TYPE import cannot pull a server catalogue into this
 * bundle, which is the point of taking it as a prop.
 */
type Dict = FormMessages;

/** Fills the `{n}` a count-bearing message carries. */
function fill(template: string, n: number): string {
  return template.replace("{n}", String(n));
}

/**
 * A code, worded for this visitor. `min`/`max` and the two length codes need the
 * number they were measured against, which is on the field rather than the code.
 */
function say(code: FormFieldErrorCode, field: PublicFormField, d: Dict): string {
  switch (code) {
    case "min":
      return fill(d.min, field.min ?? 0);
    case "max":
      return fill(d.max, field.max ?? 0);
    case "minLength":
      return fill(d.minLength, field.minLength ?? (field.required ? 1 : 0));
    case "maxLength":
      return fill(d.maxLength, field.maxLength ?? 0);
    default:
      return d[code];
  }
}

/**
 * What is wrong with this value — decided by the SHARED validator, never by a
 * second copy of the rules living here.
 *
 * The copy that used to live here is why this component shipped with no numeric
 * validation at all: it was written before the `number` type existed and nobody
 * came back to it, so the browser waved "-2" through and the visitor got a banner
 * instead of a message on the box they typed it in.
 */
function validate(field: PublicFormField, raw: string, d: Dict): string {
  const code = checkFormField(field, raw);
  return code ? say(code, field, d) : "";
}

/** One line of the basket, as the form draws it back to the visitor. */
interface BasketLine {
  value: string;
  qty: number;
  label: string;
}

/**
 * What the basket does to this form: the values it fills, and the boxes it
 * REPLACES. `slots`/`slotGroups` are what stops being asked for, because the
 * basket above them already says it.
 */
interface Plan {
  values: Record<string, string>;
  groups: string[];
  applied: FormPick[];
  lines: BasketLine[];
  slots: Set<string>;
  slotGroups: Set<string>;
}

const EMPTY_PLAN: Plan = {
  values: {},
  groups: [],
  applied: [],
  lines: [],
  slots: new Set(),
  slotGroups: new Set(),
};

/**
 * Where the basket lands in this form.
 *
 * Which boxes ARE the basket is not decided here — `formPickSlots` in
 * @zcmsorg/schemas answers that once, from the form's own declaration
 * (`role: "pick"`) or, for a form that declares nothing, from its shape. The
 * runtime and a theme's Add button therefore cannot disagree about it.
 *
 * What is left is the matching: each stored line goes into the first free slot
 * that OFFERS it, so a value the form does not sell (a drink withdrawn since the
 * basket was filled) and a line past the last slot are both dropped rather than
 * forced. The caller writes the survivors back, so the badge stops counting a line
 * that no longer exists.
 */
function planPicks(def: PublicFormDef, picks: FormPick[]): Plan {
  const basket = formPickSlots(def);
  const taken = new Set<string>();
  const values: Record<string, string> = {};
  const groups: string[] = [];
  const applied: FormPick[] = [];
  const lines: BasketLine[] = [];

  for (const pick of picks) {
    const slot = basket.slots.find(
      (field) =>
        !taken.has(field.name) &&
        (field.options ?? []).some((option) => option.value === pick.value),
    );
    if (!slot) continue;
    taken.add(slot.name);
    values[slot.name] = pick.value;
    if (slot.group) groups.push(slot.group);
    const qty = basket.quantities[slot.name];
    if (qty) values[qty.name] = String(pick.qty);
    applied.push(pick);
    lines.push({
      value: pick.value,
      qty: pick.qty,
      label:
        (slot.options ?? []).find((option) => option.value === pick.value)?.label || pick.value,
    });
  }

  // Every line box, filled or not. A basket of one drink still has to silence the
  // second and third item boxes and the button that offers them: the menu is where
  // a line is added now, so a form asking again for the thing it is already
  // showing is asking the same question twice.
  const slots = new Set<string>();
  const slotGroups = new Set<string>();
  if (lines.length > 0) {
    for (const slot of basket.slots) {
      slots.add(slot.name);
      const qty = basket.quantities[slot.name];
      if (qty) slots.add(qty.name);
      if (slot.group) slotGroups.add(slot.group);
    }
  }
  // A group that holds ANYTHING else still has to be drawn, minus its item boxes.
  for (const group of [...slotGroups]) {
    const all = def.fields.filter((field) => field.group === group);
    if (!all.every((field) => slots.has(field.name))) slotGroups.delete(group);
  }

  return { values, groups, applied, lines, slots, slotGroups };
}

/** A field's starting value: what the form declared, or empty. */
function initialValues(def: PublicFormDef): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of def.fields) {
    if (field.defaultValue != null) values[field.name] = field.defaultValue;
  }
  return values;
}

export function FormIsland({
  def,
  messages: d,
}: {
  def: PublicFormDef;
  messages: FormMessages;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(def));
  const [errors, setErrors] = useState<Record<string, string>>({});
  /**
   * Which optional groups the visitor has asked for.
   *
   * A form declares its fields flat because that is what a server validates and a
   * plugin handler reads. Somebody ordering one coffee should not be shown three
   * sets of boxes to prove it, so the groups start closed and the fields inside
   * them submit empty — exactly as they did when they were all on screen.
   */
  const [open, setOpen] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const formRef = useRef<HTMLFormElement>(null);
  /**
   * What this form's boxes are called in the DOM.
   *
   * The form id was enough while a form appeared once per page. It is not: a theme
   * that puts the same form in its basket drawer AND on the page it links to now
   * renders two of these, and two boxes sharing an `id` means every label points at
   * the first one — clicking "Phone" in the drawer would put the cursor in the form
   * behind it. `useId` is per instance and stable across hydration, which is what
   * this needs and what a counter of our own could not promise.
   */
  const uid = useId();
  /**
   * The basket as this form currently stands: the lines it shows and the boxes it
   * is therefore not asking for. Kept in state because it decides what renders,
   * and in a ref as well because emptying the basket has to know which boxes to
   * hand back — by then the plan is empty and cannot say.
   */
  const [plan, setPlan] = useState<Plan>(EMPTY_PLAN);
  const slotsRef = useRef<Plan>(EMPTY_PLAN);

  /**
   * A field that is already marked wrong re-checks itself as the visitor types, so
   * the message clears the moment it is fixed. A field that is still clean does
   * NOT — nobody wants "this field is required" while they are on the first letter
   * of their name.
   */
  const set = (name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((current) => {
      if (!current[name]) return current;
      const field = def.fields.find((f) => f.name === name);
      const message = field ? validate(field, value, d) : "";
      if (message === current[name]) return current;
      const next = { ...current };
      if (message) next[name] = message;
      else delete next[name];
      return next;
    });
  };

  /**
   * The basket, poured into this form's item slots.
   *
   * This runs on mount as well as on every change, because the Add button is
   * usually on ANOTHER page — a menu page has the list, this page has the form —
   * so what a visitor chose reaches the form as stored state, not as a click this
   * component saw. Opening the groups is part of applying: a second drink whose
   * box is still folded away has not been added, it has been hidden.
   */
  const applyPicks = useCallback(() => {
    const picks = readPicks(def.id);
    const next = planPicks(def, picks);
    // Which boxes the basket governs — from this plan while it has lines, and from
    // the last one that did when it no longer does. Emptying a basket has to hand
    // the boxes BACK, and an empty plan knows of no boxes.
    const governed = next.lines.length > 0 ? next : slotsRef.current;
    if (next.lines.length > 0) slotsRef.current = next;

    setValues((current) => {
      const values = { ...current };
      // Reset every slot first: with two drinks in the basket and one taken out,
      // the second box would otherwise keep the line that just moved up into the
      // first, and the visitor would be charged for a drink twice.
      for (const name of governed.slots) {
        const field = def.fields.find((entry) => entry.name === name);
        if (field?.defaultValue != null) values[name] = field.defaultValue;
        else delete values[name];
      }
      return { ...values, ...next.values };
    });
    setOpen((current) => [
      ...new Set([...current.filter((id) => !governed.slotGroups.has(id)), ...next.groups]),
    ]);
    setPlan(next);

    if (next.applied.length !== picks.length) writePicks(def.id, next.applied);
  }, [def]);

  useEffect(() => {
    applyPicks();
    const onPick = (event: Event) => {
      const detail = (event as CustomEvent<{ formId?: string }>).detail;
      if (detail?.formId === def.id) applyPicks();
    };
    document.addEventListener(PICK_EVENT, onPick);
    return () => document.removeEventListener(PICK_EVENT, onPick);
  }, [applyPicks, def.id]);

  /**
   * The basket is the item boxes now, so it has to do what they did.
   *
   * Taking the quantity spinner away and leaving no way to say "two of these" would
   * be a worse form, not a shorter one — so a line counts up, counts down, and goes
   * away, and every one of those writes the STORE. The store is the single copy:
   * the badge in the header, this form and the next page all read it back.
   */
  const setLine = (value: string, qty: number) => {
    const picks = readPicks(def.id)
      .map((pick) => (pick.value === value ? { ...pick, qty } : pick))
      .filter((pick) => pick.qty > 0);
    writePicks(def.id, picks);
  };

  const groups = def.groups ?? [];
  /**
   * The next group on offer — one button at a time, in declaration order, and
   * never one whose only content is item boxes the basket has taken over.
   */
  const nextGroup = groups.find(
    (group) => !open.includes(group.id) && !plan.slotGroups.has(group.id),
  );

  const openGroup = (id: string) => setOpen((current) => [...current, id]);

  /**
   * Closing a group empties it. A hidden box the visitor cannot see but the server
   * still receives is the worst of both: they removed the second coffee and were
   * charged for it anyway.
   */
  const closeGroup = (id: string) => {
    const names = def.fields.filter((field) => field.group === id).map((field) => field.name);
    // Taking a line away takes it out of the BASKET too, or the badge keeps
    // counting it and the next page pours it straight back in.
    const dropped = new Set(names.map((name) => values[name]).filter(Boolean));
    if (dropped.size > 0) {
      const kept = readPicks(def.id).filter((pick) => !dropped.has(pick.value));
      writePicks(def.id, kept);
    }
    setOpen((current) => current.filter((entry) => entry !== id));
    setValues((current) => {
      const next = { ...current };
      for (const name of names) delete next[name];
      return next;
    });
    setErrors((current) => {
      const next = { ...current };
      for (const name of names) delete next[name];
      return next;
    });
  };

  /** Puts the cursor on the first thing that is wrong, so a long form is usable. */
  const focusFirst = (invalid: Record<string, string>) => {
    const first = def.fields.find((field) => invalid[field.name]);
    if (!first) return;
    // A field name is `^[a-zA-Z][a-zA-Z0-9_]*$` (FIELD_NAME_RE), so it needs no
    // escaping — and `CSS.escape` is missing in enough environments to be worth
    // not depending on. `scrollIntoView` is guarded for the same reason.
    const el = formRef.current?.querySelector<HTMLElement>(`[name="${first.name}"]`);
    el?.focus();
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (status === "sending") return;

    const next: Record<string, string> = {};
    for (const field of def.fields) {
      const msg = validate(field, values[field.name] ?? "", d);
      if (msg) next[field.name] = msg;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      focusFirst(next);
      return;
    }

    setStatus("sending");
    try {
      const body = new URLSearchParams();
      for (const field of def.fields) body.set(field.name, (values[field.name] ?? "").trim());
      const res = await fetch(`/api/forms/${encodeURIComponent(def.id)}/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({ ok: res.ok }))) as {
        ok?: boolean;
        fields?: Record<string, FormFieldErrorCode>;
      };

      if (res.ok && data.ok !== false) {
        setValues({});
        setErrors({});
        // The order is placed: the basket that filled it is spent, badge and all.
        writePicks(def.id, []);
        setStatus("ok");
        return;
      }

      // The server refused, and said which fields. Wording is still ours, so a
      // rule only the server knows still reads in the visitor's language, on the
      // input it belongs to — instead of a banner telling them to go and look.
      const fromServer: Record<string, string> = {};
      for (const field of def.fields) {
        const code = data.fields?.[field.name];
        if (code) fromServer[field.name] = say(code, field, d);
      }
      // A message on a field nobody can see is not a message. If the server
      // refused something inside a closed group, open it before pointing at it.
      const reveal = def.fields
        .filter((field) => field.group && fromServer[field.name])
        .map((field) => field.group!);
      if (reveal.length) setOpen((current) => [...new Set([...current, ...reveal])]);
      // Same rule for a box the BASKET is standing in for: if the server refused
      // one of those, the visitor needs the control back to fix it, or the form is
      // a dead end that only says "check the fields" about a field it is hiding.
      if (Object.keys(fromServer).some((name) => plan.slots.has(name))) setPlan(EMPTY_PLAN);

      setErrors(fromServer);
      setStatus("error");
      focusFirst(fromServer);
    } catch {
      setStatus("error");
    }
  }

  if (status === "ok") {
    return (
      <div className="zcms-form zcms-form--done" role="status" style={BANNER_OK}>
        {def.successMessage || d.ok}
      </div>
    );
  }

  const renderField = (field: PublicFormField) => (
    <div className="zcms-form__field" key={field.name} style={FIELD}>
      <label className="zcms-form__label" htmlFor={`zf-${uid}-${field.name}`} style={LABEL}>
        {field.label || field.name}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <Control
        uid={uid}
        field={field}
        value={values[field.name] ?? ""}
        onChange={set}
        d={d}
        invalid={Boolean(errors[field.name])}
      />
      {errors[field.name] ? (
        <span
          className="zcms-form__error"
          id={`zf-${uid}-${field.name}-error`}
          role="alert"
          style={ERR}
        >
          {errors[field.name]}
        </span>
      ) : null}
    </div>
  );

  /**
   * The basket, drawn where the item boxes used to be.
   *
   * It is not a summary printed beside the form — it IS those fields. Their values
   * are still in `values` and still submitted under the names the plugin reads, so
   * nothing downstream knows the difference; what changed is that a visitor who
   * already chose a drink on the menu is not asked to choose it again from a
   * dropdown, next to a quantity box saying the same thing a third time.
   */
  const basket = (
    <div className="zcms-form__basket" key="__basket" style={BASKET}>
      <span className="zcms-form__label" style={LABEL}>
        {d.basket}
      </span>
      <ul className="zcms-form__basket-lines" style={LINES}>
        {plan.lines.map((line) => (
          <li className="zcms-form__basket-line" key={line.value} style={LINE}>
            <span style={{ flex: 1 }}>{line.label}</span>
            <span className="zcms-form__basket-qty" style={QTY}>
              <button
                type="button"
                onClick={() => setLine(line.value, line.qty - 1)}
                aria-label={d.less}
                style={STEP}
              >
                −
              </button>
              <b style={{ minWidth: 18, textAlign: "center" }}>{line.qty}</b>
              <button
                type="button"
                onClick={() => setLine(line.value, line.qty + 1)}
                aria-label={d.more}
                style={STEP}
              >
                +
              </button>
            </span>
            <button
              type="button"
              className="zcms-form__basket-remove"
              onClick={() => setLine(line.value, 0)}
              aria-label={`${d.removeLine}: ${line.label}`}
              style={GHOST_BTN}
            >
              {d.removeLine}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  /**
   * The ungrouped fields, with the basket standing in for the first box it took
   * over. In place rather than at the top: the item boxes sat between "how would
   * you like it?" and the pickup time, and that is where a reader looks for them.
   */
  const lead: ReactNode[] = [];
  let drawn = false;
  for (const field of def.fields) {
    if (field.group) continue;
    if (plan.slots.has(field.name)) {
      if (!drawn) lead.push(basket);
      drawn = true;
      continue;
    }
    lead.push(renderField(field));
  }

  return (
    <form className="zcms-form" ref={formRef} onSubmit={onSubmit} noValidate style={FORM}>
      {def.title ? <h3 className="zcms-form__title" style={TITLE}>{def.title}</h3> : null}
      {/* Ungrouped fields first: the form as it always was, minus the optional
          extras that used to sit in the middle of it. */}
      {lead}

      {/* Then each group the visitor opened, boxed so it reads as one thing that
          can be taken away again rather than four more boxes in a column. */}
      {groups
        .filter((group) => open.includes(group.id) && !plan.slotGroups.has(group.id))
        .map((group) => (
          <fieldset className="zcms-form__group" key={group.id} style={GROUP}>
            {group.label || group.removeLabel ? (
              <div className="zcms-form__group-head" style={GROUP_HEAD}>
                {group.label ? (
                  <legend className="zcms-form__group-title" style={GROUP_TITLE}>
                    {group.label}
                  </legend>
                ) : (
                  <span />
                )}
                {group.removeLabel ? (
                  <button
                    type="button"
                    className="zcms-form__group-remove"
                    onClick={() => closeGroup(group.id)}
                    style={GHOST_BTN}
                  >
                    {group.removeLabel}
                  </button>
                ) : null}
              </div>
            ) : null}
            {def.fields
              .filter((field) => field.group === group.id && !plan.slots.has(field.name))
              .map(renderField)}
          </fieldset>
        ))}

      {/* One button, for the next group only. Offering all of them at once would
          put the whole form back on the page in the shape of buttons. */}
      {nextGroup ? (
        <button
          type="button"
          className="zcms-form__add"
          onClick={() => openGroup(nextGroup.id)}
          style={ADD_BTN}
        >
          {nextGroup.addLabel}
        </button>
      ) : null}

      {status === "error" ? (
        <div className="zcms-form__banner" role="alert" style={BANNER_ERR}>{d.error}</div>
      ) : null}
      <button className="zcms-form__submit" type="submit" disabled={status === "sending"} style={BTN}>
        {status === "sending" ? d.sending : def.submitLabel || d.send}
      </button>
    </form>
  );
}

function Control({
  uid,
  field,
  value,
  onChange,
  d,
  invalid,
}: {
  uid: string;
  field: PublicFormField;
  value: string;
  onChange: (name: string, value: string) => void;
  d: Dict;
  invalid: boolean;
}) {
  const id = `zf-${uid}-${field.name}`;
  const common = {
    id,
    name: field.name,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange(field.name, e.target.value),
    // A red border alone is a message only some readers receive; these two are how
    // a screen reader is told the same thing, and which text explains it.
    "aria-invalid": invalid || undefined,
    "aria-describedby": invalid ? `${id}-error` : undefined,
    style: invalid ? { ...INPUT, borderColor: "#dc2626" } : INPUT,
  };
  if (field.type === "textarea") return <textarea {...common} rows={5} />;
  if (field.type === "select") {
    return (
      <select {...common}>
        {/* A named empty choice, not a blank line: an unlabelled first option reads
            as a value the visitor might have already picked. */}
        <option value="">{d.choose}</option>
        {(field.options ?? []).map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }
  // `date` maps to the native date input — a real calendar picker, in the visitor's
  // own locale, which is the point of the type existing.
  const inputType =
    field.type === "email"
      ? "email"
      : field.type === "url"
        ? "url"
        : field.type === "tel"
          ? "tel"
          : field.type === "number"
            ? "number"
            : field.type === "date"
              ? "date"
              : "text";
  // The declared bounds reach the control itself, so a number spinner will not
  // offer a value the form is going to refuse.
  const bounds =
    field.type === "number"
      ? // `step` is the declaration's, so a quantity spinner counts in whole
        // drinks and a weight can still be a half kilo. Absent means "any".
        { min: field.min, max: field.max, step: field.step ?? "any" }
      : { minLength: field.minLength, maxLength: field.maxLength };
  return <input {...common} {...bounds} type={inputType} />;
}

// Neutral, self-contained styling so a plugin form is usable on any theme; the
// `zcms-form*` class hooks let a theme restyle it without the plugin shipping CSS.
const FORM: React.CSSProperties = { display: "grid", gap: 14, maxWidth: 560 };
const TITLE: React.CSSProperties = { margin: "0 0 4px", fontSize: 20, fontWeight: 700 };
const FIELD: React.CSSProperties = { display: "grid", gap: 6 };
const LABEL: React.CSSProperties = { fontSize: 13, fontWeight: 600 };
const INPUT: React.CSSProperties = {
  font: "inherit",
  padding: "10px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 10,
  background: "#fff",
  color: "#0f172a",
  width: "100%",
  boxSizing: "border-box",
};
const ERR: React.CSSProperties = { color: "#b91c1c", fontSize: 13 };
const GROUP: React.CSSProperties = {
  display: "grid",
  gap: 14,
  margin: 0,
  padding: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "rgba(15,23,42,.02)",
};
const BASKET: React.CSSProperties = {
  display: "grid",
  gap: 8,
  padding: 14,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "rgba(15,23,42,.02)",
};
const LINES: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: 8,
};
const LINE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};
const QTY: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};
const STEP: React.CSSProperties = {
  font: "inherit",
  lineHeight: 1,
  width: 26,
  height: 26,
  padding: 0,
  border: "1px solid #cbd5e1",
  borderRadius: 999,
  background: "#fff",
  color: "#0f172a",
  cursor: "pointer",
};
const GROUP_HEAD: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 12,
};
const GROUP_TITLE: React.CSSProperties = { padding: 0, fontSize: 13, fontWeight: 700 };
const ADD_BTN: React.CSSProperties = {
  justifySelf: "start",
  font: "inherit",
  fontWeight: 600,
  fontSize: 14,
  padding: "8px 16px",
  border: "1px dashed #94a3b8",
  borderRadius: 999,
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};
const GHOST_BTN: React.CSSProperties = {
  font: "inherit",
  fontSize: 13,
  padding: 0,
  border: 0,
  background: "transparent",
  color: "#b91c1c",
  cursor: "pointer",
  textDecoration: "underline",
};
const BANNER_OK: React.CSSProperties = {
  padding: "14px 18px",
  borderRadius: 12,
  background: "rgba(22,163,74,.12)",
  border: "1px solid rgba(22,163,74,.35)",
  color: "#15803d",
  maxWidth: 560,
};
const BANNER_ERR: React.CSSProperties = {
  padding: "12px 16px",
  borderRadius: 10,
  background: "rgba(220,38,38,.1)",
  border: "1px solid rgba(220,38,38,.35)",
  color: "#b91c1c",
};
const BTN: React.CSSProperties = {
  justifySelf: "start",
  font: "inherit",
  fontWeight: 700,
  padding: "10px 20px",
  border: 0,
  borderRadius: 999,
  background: "#0f172a",
  color: "#fff",
  cursor: "pointer",
};
