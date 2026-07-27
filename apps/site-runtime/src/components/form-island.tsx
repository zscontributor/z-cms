"use client";

import { useState } from "react";
import type { PublicFormDef, PublicFormField } from "@zcmsorg/schemas";

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

type Dict = {
  required: string;
  email: string;
  url: string;
  pattern: string;
  min: (n: number) => string;
  max: (n: number) => string;
  send: string;
  sending: string;
  ok: string;
  error: string;
};

const MESSAGES: Record<string, Dict> = {
  en: {
    required: "This field is required.",
    email: "Please enter a valid email address, e.g. name@example.com.",
    url: "Please enter a valid URL starting with http:// or https://.",
    pattern: "This value is not in the expected format.",
    min: (n) => `Please use at least ${n} characters.`,
    max: (n) => `Please use at most ${n} characters.`,
    send: "Send",
    sending: "Sending…",
    ok: "Thank you! Your submission has been received.",
    error: "Sorry, that could not be sent. Please check the fields and try again.",
  },
  vi: {
    required: "Vui lòng nhập trường này.",
    email: "Vui lòng nhập email hợp lệ, ví dụ: ten@example.com.",
    url: "Vui lòng nhập URL hợp lệ bắt đầu bằng http:// hoặc https://.",
    pattern: "Giá trị không đúng định dạng.",
    min: (n) => `Vui lòng nhập tối thiểu ${n} ký tự.`,
    max: (n) => `Vui lòng nhập tối đa ${n} ký tự.`,
    send: "Gửi",
    sending: "Đang gửi…",
    ok: "Cảm ơn bạn! Chúng tôi đã nhận được thông tin.",
    error: "Rất tiếc, chưa gửi được. Vui lòng kiểm tra lại các trường và thử lại.",
  },
  ja: {
    required: "この項目は必須です。",
    email: "有効なメールアドレスを入力してください（例: name@example.com）。",
    url: "http:// または https:// で始まる有効なURLを入力してください。",
    pattern: "形式が正しくありません。",
    min: (n) => `${n}文字以上で入力してください。`,
    max: (n) => `${n}文字以内で入力してください。`,
    send: "送信",
    sending: "送信中…",
    ok: "ありがとうございます。送信を受け付けました。",
    error: "申し訳ありません。送信できませんでした。項目を確認して再度お試しください。",
  },
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

function validate(field: PublicFormField, raw: string, d: Dict): string {
  const value = raw.trim();
  if (!value) return field.required ? d.required : "";
  if (field.type === "email" && !EMAIL_RE.test(value)) return d.email;
  if (field.type === "url" && !URL_RE.test(value)) return d.url;
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(value)) return d.pattern;
    } catch {
      /* an unparsable pattern never blocks the visitor; the server is authoritative */
    }
  }
  if (field.minLength != null && value.length < field.minLength) return d.min(field.minLength);
  if (field.maxLength != null && value.length > field.maxLength) return d.max(field.maxLength);
  return "";
}

export function FormIsland({ def, locale }: { def: PublicFormDef; locale: string }) {
  const d = MESSAGES[locale.slice(0, 2)] ?? MESSAGES.en!;
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "sending" | "ok" | "error">("idle");

  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (status === "sending") return;

    const next: Record<string, string> = {};
    for (const field of def.fields) {
      const msg = validate(field, values[field.name] ?? "", d);
      if (msg) next[field.name] = msg;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

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
      const data = res.ok ? ((await res.json().catch(() => ({ ok: res.ok }))) as { ok?: boolean }) : { ok: false };
      if (data.ok !== false) {
        setValues({});
        setStatus("ok");
      } else {
        setStatus("error");
      }
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

  return (
    <form className="zcms-form" onSubmit={onSubmit} noValidate style={FORM}>
      {def.title ? <h3 className="zcms-form__title" style={TITLE}>{def.title}</h3> : null}
      {def.fields.map((field) => (
        <div className="zcms-form__field" key={field.name} style={FIELD}>
          <label className="zcms-form__label" htmlFor={`zf-${def.id}-${field.name}`} style={LABEL}>
            {field.label || field.name}
            {field.required ? <span aria-hidden="true"> *</span> : null}
          </label>
          <Control def={def} field={field} value={values[field.name] ?? ""} onChange={set} />
          {errors[field.name] ? (
            <span className="zcms-form__error" role="alert" style={ERR}>{errors[field.name]}</span>
          ) : null}
        </div>
      ))}
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
}: {
  def: PublicFormDef;
  field: PublicFormField;
  value: string;
  onChange: (name: string, value: string) => void;
}) {
  const id = `zf-${def.id}-${field.name}`;
  const common = {
    id,
    name: field.name,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange(field.name, e.target.value),
    style: INPUT,
  };
  if (field.type === "textarea") return <textarea {...common} rows={5} />;
  if (field.type === "select") {
    return (
      <select {...common}>
        <option value="" />
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }
  const inputType =
    field.type === "email" ? "email" : field.type === "url" ? "url" : field.type === "tel" ? "tel" : field.type === "number" ? "number" : "text";
  return <input {...common} type={inputType} />;
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
