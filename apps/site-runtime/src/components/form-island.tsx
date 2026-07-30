"use client";

import { useRef, useState } from "react";
import { checkFormField } from "@zcmsorg/schemas";
import type { FormFieldErrorCode, PublicFormDef, PublicFormField } from "@zcmsorg/schemas";

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
 * Every refusal the shared validator can return, in the visitor's language.
 *
 * Keyed by `FormFieldErrorCode`, so a code that arrives from the SERVER — for a
 * rule this browser never ran — is worded here rather than shipped as English
 * prose from an API. `min`/`max` are about a NUMBER's value; `minLength`/
 * `maxLength` are about a string's length. Conflating the two is how "at least 1"
 * became "at least 1 characters" on a quantity box.
 */
type Dict = {
  required: string;
  email: string;
  url: string;
  date: string;
  pattern: string;
  number: string;
  min: (n: number) => string;
  max: (n: number) => string;
  minLength: (n: number) => string;
  maxLength: (n: number) => string;
  invalid: string;
  send: string;
  sending: string;
  ok: string;
  error: string;
  choose: string;
};

const MESSAGES: Record<string, Dict> = {
  en: {
    required: "This field is required.",
    email: "Please enter a valid email address, e.g. name@example.com.",
    url: "Please enter a valid URL starting with http:// or https://.",
    date: "Please choose a valid date.",
    pattern: "This value is not in the expected format.",
    number: "Please enter a number.",
    min: (n) => `Please enter ${n} or more.`,
    max: (n) => `Please enter ${n} or less.`,
    minLength: (n) => `Please use at least ${n} characters.`,
    maxLength: (n) => `Please use at most ${n} characters.`,
    invalid: "Please choose one of the options.",
    send: "Send",
    sending: "Sending…",
    ok: "Thank you! Your submission has been received.",
    error: "Sorry, that could not be sent. Please check the fields and try again.",
    choose: "— Please choose —",
  },
  vi: {
    required: "Vui lòng nhập trường này.",
    email: "Vui lòng nhập email hợp lệ, ví dụ: ten@example.com.",
    url: "Vui lòng nhập URL hợp lệ bắt đầu bằng http:// hoặc https://.",
    date: "Vui lòng chọn ngày hợp lệ.",
    pattern: "Giá trị không đúng định dạng.",
    number: "Vui lòng nhập một con số.",
    min: (n) => `Vui lòng nhập từ ${n} trở lên.`,
    max: (n) => `Vui lòng nhập tối đa ${n}.`,
    minLength: (n) => `Vui lòng nhập tối thiểu ${n} ký tự.`,
    maxLength: (n) => `Vui lòng nhập tối đa ${n} ký tự.`,
    invalid: "Vui lòng chọn một trong các lựa chọn.",
    send: "Gửi",
    sending: "Đang gửi…",
    ok: "Cảm ơn bạn! Chúng tôi đã nhận được thông tin.",
    error: "Rất tiếc, chưa gửi được. Vui lòng kiểm tra lại các trường và thử lại.",
    choose: "— Vui lòng chọn —",
  },
  ja: {
    required: "この項目は必須です。",
    email: "有効なメールアドレスを入力してください（例: name@example.com）。",
    url: "http:// または https:// で始まる有効なURLを入力してください。",
    date: "有効な日付を選択してください。",
    pattern: "形式が正しくありません。",
    number: "数値を入力してください。",
    min: (n) => `${n} 以上の値を入力してください。`,
    max: (n) => `${n} 以下の値を入力してください。`,
    minLength: (n) => `${n}文字以上で入力してください。`,
    maxLength: (n) => `${n}文字以内で入力してください。`,
    invalid: "選択肢の中から選んでください。",
    send: "送信",
    sending: "送信中…",
    ok: "ありがとうございます。送信を受け付けました。",
    error: "申し訳ありません。送信できませんでした。項目を確認して再度お試しください。",
    choose: "— 選択してください —",
  },
};

/**
 * A code, worded for this visitor. `min`/`max` and the two length codes need the
 * number they were measured against, which is on the field rather than the code.
 */
function say(code: FormFieldErrorCode, field: PublicFormField, d: Dict): string {
  switch (code) {
    case "min":
      return d.min(field.min ?? 0);
    case "max":
      return d.max(field.max ?? 0);
    case "minLength":
      return d.minLength(field.minLength ?? (field.required ? 1 : 0));
    case "maxLength":
      return d.maxLength(field.maxLength ?? 0);
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

/** A field's starting value: what the form declared, or empty. */
function initialValues(def: PublicFormDef): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of def.fields) {
    if (field.defaultValue != null) values[field.name] = field.defaultValue;
  }
  return values;
}

export function FormIsland({ def, locale }: { def: PublicFormDef; locale: string }) {
  const d = MESSAGES[locale.slice(0, 2)] ?? MESSAGES.en!;
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

  const groups = def.groups ?? [];
  /** The next group on offer — one button at a time, in declaration order. */
  const nextGroup = groups.find((group) => !open.includes(group.id));

  const openGroup = (id: string) => setOpen((current) => [...current, id]);

  /**
   * Closing a group empties it. A hidden box the visitor cannot see but the server
   * still receives is the worst of both: they removed the second coffee and were
   * charged for it anyway.
   */
  const closeGroup = (id: string) => {
    const names = def.fields.filter((field) => field.group === id).map((field) => field.name);
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
      <label className="zcms-form__label" htmlFor={`zf-${def.id}-${field.name}`} style={LABEL}>
        {field.label || field.name}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <Control
        def={def}
        field={field}
        value={values[field.name] ?? ""}
        onChange={set}
        d={d}
        invalid={Boolean(errors[field.name])}
      />
      {errors[field.name] ? (
        <span
          className="zcms-form__error"
          id={`zf-${def.id}-${field.name}-error`}
          role="alert"
          style={ERR}
        >
          {errors[field.name]}
        </span>
      ) : null}
    </div>
  );

  return (
    <form className="zcms-form" ref={formRef} onSubmit={onSubmit} noValidate style={FORM}>
      {def.title ? <h3 className="zcms-form__title" style={TITLE}>{def.title}</h3> : null}
      {/* Ungrouped fields first: the form as it always was, minus the optional
          extras that used to sit in the middle of it. */}
      {def.fields.filter((field) => !field.group).map(renderField)}

      {/* Then each group the visitor opened, boxed so it reads as one thing that
          can be taken away again rather than four more boxes in a column. */}
      {groups
        .filter((group) => open.includes(group.id))
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
            {def.fields.filter((field) => field.group === group.id).map(renderField)}
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
  def,
  field,
  value,
  onChange,
  d,
  invalid,
}: {
  def: PublicFormDef;
  field: PublicFormField;
  value: string;
  onChange: (name: string, value: string) => void;
  d: Dict;
  invalid: boolean;
}) {
  const id = `zf-${def.id}-${field.name}`;
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
