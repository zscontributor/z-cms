"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommercePublicConfig } from "@zcmsorg/schemas";

/**
 * The storefront: a first-party, runtime-owned cart and checkout.
 *
 * A theme cannot ship this — it renders on the server and may not carry client
 * JavaScript — so, exactly like the AI assistant, the theme reserves a POSITION
 * (the "commerce" slot) and the runtime mounts the interactive UI. The theme's only
 * other job is to render add-to-cart buttons as plain HTML carrying `data-zc-*`
 * attributes; this component listens for clicks on them through event delegation on
 * `document`, so it never holds a reference to any theme's markup.
 *
 * The cart lives in localStorage. It becomes an order only at checkout, where
 * cms-api re-derives every price from the product's own content — so nothing stored
 * or edited in the browser can change what an order costs.
 *
 * It is deliberately styled through `--zc-*` CSS custom properties with neutral
 * fallbacks, so any theme can make it its own by setting a handful of variables on
 * the element it renders the slot inside.
 */

interface CartItem {
  productId: string;
  slug: string;
  title: string;
  image: string | null;
  price: number;
  currency: string;
  quantity: number;
}

const STORAGE_KEY = "zc.cart.v1";
const MAX_QTY = 99;

type Dict = {
  cart: string;
  empty: string;
  continue: string;
  checkout: string;
  subtotal: string;
  shipping: string;
  free: string;
  total: string;
  remove: string;
  qtyDown: string;
  qtyUp: string;
  close: string;
  back: string;
  yourDetails: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  note: string;
  notePlaceholder: string;
  payment: string;
  cod: string;
  codHint: string;
  placeOrder: string;
  placing: string;
  review: string;
  orderPlaced: string;
  orderNumber: string;
  thanks: string;
  done: string;
  unavailable: string;
  genericError: string;
  freeShippingHint: string;
  items: string;
};

const MESSAGES: Record<string, Dict> = {
  en: {
    cart: "Your cart", empty: "Your cart is empty.", continue: "Continue shopping",
    checkout: "Checkout", subtotal: "Subtotal", shipping: "Shipping", free: "Free",
    total: "Total", remove: "Remove", qtyDown: "Decrease quantity", qtyUp: "Increase quantity",
    close: "Close", back: "Back", yourDetails: "Delivery details", name: "Full name",
    email: "Email", phone: "Phone", address: "Address", city: "City / Province",
    note: "Order note (optional)", notePlaceholder: "Anything we should know?",
    payment: "Payment", cod: "Cash on delivery", codHint: "Pay in cash when your order arrives.",
    placeOrder: "Place order", placing: "Placing order…", review: "Review & pay",
    orderPlaced: "Order placed", orderNumber: "Order", thanks: "Thank you for your order.",
    done: "Done", unavailable: "Some items are no longer available and were removed.",
    genericError: "Something went wrong. Please try again.",
    freeShippingHint: "Free shipping over {amount}.", items: "items",
  },
  vi: {
    cart: "Giỏ hàng của bạn", empty: "Giỏ hàng đang trống.", continue: "Tiếp tục mua sắm",
    checkout: "Thanh toán", subtotal: "Tạm tính", shipping: "Phí vận chuyển", free: "Miễn phí",
    total: "Tổng cộng", remove: "Xóa", qtyDown: "Giảm số lượng", qtyUp: "Tăng số lượng",
    close: "Đóng", back: "Quay lại", yourDetails: "Thông tin giao hàng", name: "Họ và tên",
    email: "Email", phone: "Số điện thoại", address: "Địa chỉ", city: "Tỉnh / Thành phố",
    note: "Ghi chú đơn hàng (không bắt buộc)", notePlaceholder: "Điều gì chúng tôi cần biết?",
    payment: "Thanh toán", cod: "Thanh toán khi nhận hàng (COD)",
    codHint: "Trả tiền mặt khi đơn hàng được giao đến.",
    placeOrder: "Đặt hàng", placing: "Đang đặt hàng…", review: "Xem lại & thanh toán",
    orderPlaced: "Đã đặt hàng", orderNumber: "Đơn hàng", thanks: "Cảm ơn bạn đã đặt hàng.",
    done: "Xong", unavailable: "Một vài sản phẩm không còn khả dụng và đã được gỡ khỏi giỏ.",
    genericError: "Đã có lỗi xảy ra. Vui lòng thử lại.",
    freeShippingHint: "Miễn phí vận chuyển cho đơn từ {amount}.", items: "sản phẩm",
  },
  ja: {
    cart: "カート", empty: "カートは空です。", continue: "買い物を続ける",
    checkout: "レジに進む", subtotal: "小計", shipping: "配送料", free: "無料",
    total: "合計", remove: "削除", qtyDown: "数量を減らす", qtyUp: "数量を増やす",
    close: "閉じる", back: "戻る", yourDetails: "お届け先", name: "お名前",
    email: "メール", phone: "電話番号", address: "住所", city: "都道府県・市区町村",
    note: "備考（任意）", notePlaceholder: "ご要望があればご記入ください",
    payment: "お支払い", cod: "代金引換", codHint: "商品お届け時に現金でお支払いください。",
    placeOrder: "注文する", placing: "注文処理中…", review: "確認して支払う",
    orderPlaced: "注文が完了しました", orderNumber: "注文番号", thanks: "ご注文ありがとうございます。",
    done: "閉じる", unavailable: "一部の商品は在庫切れのため削除されました。",
    genericError: "エラーが発生しました。もう一度お試しください。",
    freeShippingHint: "{amount} 以上で送料無料。", items: "点",
  },
};

interface QuoteResponse {
  currency: string;
  items: {
    productId: string;
    slug: string;
    title: string;
    image: string | null;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
    available: boolean;
  }[];
  subtotal: number;
  shippingFee: number;
  total: number;
  valid: boolean;
}

interface PlacedOrder {
  orderNumber: string;
  total: number;
  currency: string;
}

function readCart(): CartItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is CartItem =>
        !!item &&
        typeof item === "object" &&
        typeof (item as CartItem).productId === "string" &&
        typeof (item as CartItem).price === "number" &&
        typeof (item as CartItem).quantity === "number",
      )
      .map((item) => ({ ...item, quantity: Math.min(MAX_QTY, Math.max(1, Math.round(item.quantity))) }));
  } catch {
    return [];
  }
}

export function Storefront({ config, locale }: { config: CommercePublicConfig; locale: string }) {
  const t = MESSAGES[locale] ?? MESSAGES.en!;
  const [mounted, setMounted] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"cart" | "info" | "done">("cart");
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [placed, setPlaced] = useState<PlacedOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", address: "", city: "", note: "" });
  const panelRef = useRef<HTMLDivElement>(null);

  const fmt = useCallback(
    (value: number, currency = config.currency) => {
      try {
        return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
      } catch {
        return `${value} ${currency}`;
      }
    },
    [config.currency, locale],
  );

  // Hydrate from localStorage after mount, so the server and first client paint
  // agree (both render nothing) and there is no hydration mismatch.
  useEffect(() => {
    setMounted(true);
    setCart(readCart());
  }, []);

  // Persist, and mirror the count onto any [data-zc-cart-count] the theme rendered
  // in its header — the badge on the bag icon lives in the theme's markup.
  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // A private-mode browser with no storage still gets a working session cart.
    }
    const count = cart.reduce((sum, item) => sum + item.quantity, 0);
    document.querySelectorAll<HTMLElement>("[data-zc-cart-count]").forEach((el) => {
      el.textContent = String(count);
      el.toggleAttribute("hidden", count === 0);
    });
  }, [cart, mounted]);

  const addItem = useCallback((raw: Omit<CartItem, "quantity">, qty: number) => {
    setError(null);
    setCart((current) => {
      const existing = current.find((item) => item.productId === raw.productId);
      if (existing) {
        return current.map((item) =>
          item.productId === raw.productId
            ? { ...item, quantity: Math.min(MAX_QTY, item.quantity + qty) }
            : item,
        );
      }
      return [...current, { ...raw, quantity: Math.min(MAX_QTY, qty) }];
    });
    setStep("cart");
    setPlaced(null);
    setOpen(true);
  }, []);

  // Event delegation on the document: the theme's add-to-cart buttons and its bag
  // icon are plain HTML the runtime never imports — it recognises them by their
  // data attributes, exactly as the colour-mode toggle recognises its own.
  useEffect(() => {
    if (!mounted) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const opener = target.closest("[data-zc-cart-open]");
      if (opener) {
        event.preventDefault();
        setPlaced(null);
        setStep("cart");
        setOpen(true);
        return;
      }

      const add = target.closest<HTMLElement>("[data-zc-add]");
      if (add) {
        const id = add.getAttribute("data-zc-id");
        const price = Number(add.getAttribute("data-zc-price"));
        if (!id || !Number.isFinite(price)) return;
        event.preventDefault();
        addItem(
          {
            productId: id,
            slug: add.getAttribute("data-zc-slug") ?? "",
            title: add.getAttribute("data-zc-title") ?? "",
            image: add.getAttribute("data-zc-image") || null,
            price,
            currency: add.getAttribute("data-zc-currency") || config.currency,
          },
          Math.max(1, Number(add.getAttribute("data-zc-qty")) || 1),
        );
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [mounted, addItem, config.currency]);

  // Escape closes the drawer, and focus moves into it when it opens.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const setQty = useCallback((productId: string, quantity: number) => {
    setCart((current) =>
      quantity <= 0
        ? current.filter((item) => item.productId !== productId)
        : current.map((item) =>
            item.productId === productId
              ? { ...item, quantity: Math.min(MAX_QTY, quantity) }
              : item,
          ),
    );
  }, []);

  const count = cart.reduce((sum, item) => sum + item.quantity, 0);

  // Client-side totals mirror the server's rule; the server's are authoritative and
  // reconciled at checkout via the quote below.
  const local = useMemo(() => {
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const freeShip =
      config.freeShippingThreshold !== null && subtotal >= config.freeShippingThreshold;
    const shipping = cart.length && !freeShip ? config.shippingFlatFee : 0;
    return { subtotal, shipping, total: subtotal + shipping };
  }, [cart, config.freeShippingThreshold, config.shippingFlatFee]);

  const totals = quote && step !== "cart"
    ? { subtotal: quote.subtotal, shipping: quote.shippingFee, total: quote.total }
    : local;

  async function goToCheckout() {
    setError(null);
    try {
      const response = await fetch("/api/commerce/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: cart.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        }),
      });
      const data = (await response.json()) as QuoteResponse;
      if (!response.ok || !data.valid) {
        setError(t.genericError);
        return;
      }
      // Drop anything the shop no longer sells, and refresh prices to the server's.
      const available = new Map(data.items.filter((i) => i.available).map((i) => [i.productId, i]));
      if (available.size !== cart.length) setError(t.unavailable);
      setCart((current) =>
        current
          .filter((item) => available.has(item.productId))
          .map((item) => ({ ...item, price: available.get(item.productId)!.unitPrice })),
      );
      if (available.size === 0) {
        setStep("cart");
        return;
      }
      setQuote(data);
      setStep("info");
    } catch {
      setError(t.genericError);
    }
  }

  async function placeOrder(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/commerce/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          items: cart.map((item) => ({ productId: item.productId, quantity: item.quantity })),
          customer: {
            name: form.name,
            email: form.email,
            phone: form.phone,
            address: form.address,
            city: form.city,
          },
          paymentMethod: "COD",
          note: form.note || undefined,
          locale,
        }),
      });
      const data = (await response.json()) as PlacedOrder & { message?: string };
      if (!response.ok || !data.orderNumber) {
        setError(data.message || t.genericError);
        return;
      }
      setPlaced({ orderNumber: data.orderNumber, total: data.total, currency: data.currency });
      setCart([]);
      setStep("done");
    } catch {
      setError(t.genericError);
    } finally {
      setSubmitting(false);
    }
  }

  if (!mounted) return null;

  return (
    <div className="zc-root">
      <style>{CSS}</style>

      <button
        type="button"
        className="zc-fab"
        aria-label={t.cart}
        onClick={() => {
          setPlaced(null);
          setStep("cart");
          setOpen(true);
        }}
      >
        <span aria-hidden="true" className="zc-fab-icon">🛍</span>
        {count > 0 ? <span className="zc-fab-badge">{count}</span> : null}
      </button>

      {open ? (
        <div className="zc-overlay" onClick={() => setOpen(false)}>
          <div
            className="zc-panel"
            role="dialog"
            aria-modal="true"
            aria-label={t.cart}
            tabIndex={-1}
            ref={panelRef}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="zc-head">
              {step === "info" && !placed ? (
                <button type="button" className="zc-icon-btn" onClick={() => setStep("cart")} aria-label={t.back}>←</button>
              ) : (
                <span className="zc-head-icon" aria-hidden="true">🛍</span>
              )}
              <strong className="zc-title">
                {step === "done" ? t.orderPlaced : step === "info" ? t.checkout : t.cart}
              </strong>
              <button type="button" className="zc-icon-btn" onClick={() => setOpen(false)} aria-label={t.close}>×</button>
            </header>

            {error ? <p className="zc-error" role="alert">{error}</p> : null}

            {step === "done" && placed ? (
              <div className="zc-body zc-done">
                <div className="zc-done-mark" aria-hidden="true">✓</div>
                <p className="zc-done-thanks">{t.thanks}</p>
                <p className="zc-done-order">
                  {t.orderNumber} #{placed.orderNumber}
                </p>
                <p className="zc-done-total">{fmt(placed.total, placed.currency)} · {t.cod}</p>
                <button
                  type="button"
                  className="zc-btn zc-btn-primary"
                  onClick={() => {
                    setOpen(false);
                    setPlaced(null);
                  }}
                >
                  {t.done}
                </button>
              </div>
            ) : cart.length === 0 ? (
              <div className="zc-body zc-empty">
                <p>{t.empty}</p>
                <button type="button" className="zc-btn" onClick={() => setOpen(false)}>{t.continue}</button>
              </div>
            ) : step === "cart" ? (
              <>
                <div className="zc-body">
                  <ul className="zc-lines">
                    {cart.map((item) => (
                      <li className="zc-line" key={item.productId}>
                        <div className="zc-line-art" aria-hidden="true">
                          {item.image ? <img src={item.image} alt="" /> : <span>🧴</span>}
                        </div>
                        <div className="zc-line-main">
                          <p className="zc-line-title">{item.title || item.slug}</p>
                          <p className="zc-line-price">{fmt(item.price, item.currency)}</p>
                          <div className="zc-qty">
                            <button type="button" aria-label={t.qtyDown} onClick={() => setQty(item.productId, item.quantity - 1)}>−</button>
                            <span>{item.quantity}</span>
                            <button type="button" aria-label={t.qtyUp} onClick={() => setQty(item.productId, item.quantity + 1)}>+</button>
                            <button type="button" className="zc-remove" onClick={() => setQty(item.productId, 0)}>{t.remove}</button>
                          </div>
                        </div>
                        <div className="zc-line-total">{fmt(item.price * item.quantity, item.currency)}</div>
                      </li>
                    ))}
                  </ul>
                </div>
                <footer className="zc-foot">
                  <Totals t={t} fmt={fmt} totals={local} config={config} />
                  <button type="button" className="zc-btn zc-btn-primary" onClick={goToCheckout}>
                    {t.checkout} · {fmt(local.total)}
                  </button>
                </footer>
              </>
            ) : (
              <form className="zc-body zc-form" onSubmit={placeOrder}>
                <p className="zc-section">{t.yourDetails}</p>
                <Field id="zc-name" label={t.name} value={form.name} required onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
                <div className="zc-row">
                  <Field id="zc-email" label={t.email} type="email" value={form.email} required onChange={(v) => setForm((f) => ({ ...f, email: v }))} />
                  <Field id="zc-phone" label={t.phone} value={form.phone} required onChange={(v) => setForm((f) => ({ ...f, phone: v }))} />
                </div>
                <Field id="zc-address" label={t.address} value={form.address} required onChange={(v) => setForm((f) => ({ ...f, address: v }))} />
                <Field id="zc-city" label={t.city} value={form.city} required onChange={(v) => setForm((f) => ({ ...f, city: v }))} />
                <label className="zc-field">
                  <span>{t.note}</span>
                  <textarea
                    rows={2}
                    value={form.note}
                    placeholder={t.notePlaceholder}
                    onChange={(event) => setForm((f) => ({ ...f, note: event.target.value }))}
                  />
                </label>

                <p className="zc-section">{t.payment}</p>
                <div className="zc-pay">
                  <span className="zc-pay-dot" aria-hidden="true" />
                  <div>
                    <strong>{t.cod}</strong>
                    <span>{t.codHint}</span>
                  </div>
                </div>

                <div className="zc-foot zc-foot-inline">
                  <Totals t={t} fmt={fmt} totals={totals} config={config} />
                  <button type="submit" className="zc-btn zc-btn-primary" disabled={submitting}>
                    {submitting ? t.placing : `${t.placeOrder} · ${fmt(totals.total)}`}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Totals({
  t,
  fmt,
  totals,
  config,
}: {
  t: Dict;
  fmt: (value: number, currency?: string) => string;
  totals: { subtotal: number; shipping: number; total: number };
  config: CommercePublicConfig;
}) {
  return (
    <div className="zc-totals">
      <div><span>{t.subtotal}</span><span>{fmt(totals.subtotal)}</span></div>
      <div>
        <span>{t.shipping}</span>
        <span>{totals.shipping === 0 ? t.free : fmt(totals.shipping)}</span>
      </div>
      {config.freeShippingThreshold !== null && totals.shipping > 0 ? (
        <p className="zc-ship-hint">
          {t.freeShippingHint.replace("{amount}", fmt(config.freeShippingThreshold))}
        </p>
      ) : null}
      <div className="zc-grand"><span>{t.total}</span><span>{fmt(totals.total)}</span></div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="zc-field" htmlFor={id}>
      <span>{label}{required ? " *" : ""}</span>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

const CSS = `
.zc-root{--zc-accent:var(--zc-theme-accent,#111827);--zc-accent-ink:var(--zc-theme-accent-ink,#ffffff);
  --zc-surface:var(--zc-theme-surface,#ffffff);--zc-ink:var(--zc-theme-ink,#111827);
  --zc-muted:var(--zc-theme-muted,#6b7280);--zc-border:var(--zc-theme-border,#e5e7eb);
  --zc-radius:var(--zc-theme-radius,14px);
  font-family:var(--zc-theme-font,system-ui,-apple-system,"Segoe UI",sans-serif);}
.zc-fab{position:fixed;left:20px;bottom:20px;z-index:2147482000;width:56px;height:56px;border-radius:999px;
  border:0;cursor:pointer;background:var(--zc-accent);color:var(--zc-accent-ink);
  box-shadow:0 12px 30px rgba(15,23,42,.25);font-size:24px;line-height:1;display:flex;align-items:center;justify-content:center;}
.zc-fab-badge{position:absolute;top:-4px;right:-4px;min-width:22px;height:22px;padding:0 6px;border-radius:999px;
  background:#e11d48;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;}
.zc-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.5);display:flex;justify-content:flex-end;}
.zc-panel{width:min(440px,100vw);height:100%;background:var(--zc-surface);color:var(--zc-ink);display:flex;flex-direction:column;
  box-shadow:-20px 0 60px rgba(15,23,42,.3);outline:none;animation:zc-in .22s ease;}
@keyframes zc-in{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}
.zc-head{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--zc-border);}
.zc-title{flex:1;font-size:17px;}
.zc-head-icon{font-size:20px;}
.zc-icon-btn{border:0;background:transparent;color:inherit;font-size:22px;line-height:1;cursor:pointer;padding:4px;border-radius:8px;}
.zc-body{flex:1;overflow-y:auto;padding:16px 18px;}
.zc-error{margin:0;padding:10px 18px;background:#fef2f2;color:#b91c1c;font-size:13px;}
.zc-empty{text-align:center;color:var(--zc-muted);display:flex;flex-direction:column;gap:14px;align-items:center;padding-top:48px;}
.zc-lines{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:16px;}
.zc-line{display:grid;grid-template-columns:56px 1fr auto;gap:12px;align-items:start;}
.zc-line-art{width:56px;height:56px;border-radius:10px;background:var(--zc-border);display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:22px;}
.zc-line-art img{width:100%;height:100%;object-fit:cover;}
.zc-line-title{margin:0 0 2px;font-weight:600;font-size:14px;line-height:1.3;}
.zc-line-price{margin:0 0 6px;color:var(--zc-muted);font-size:13px;}
.zc-line-total{font-weight:600;font-size:14px;white-space:nowrap;}
.zc-qty{display:flex;align-items:center;gap:8px;}
.zc-qty button{width:26px;height:26px;border:1px solid var(--zc-border);background:var(--zc-surface);color:inherit;border-radius:8px;cursor:pointer;font-size:15px;line-height:1;}
.zc-qty span{min-width:20px;text-align:center;font-size:14px;}
.zc-remove{width:auto!important;padding:0 6px;font-size:12px!important;color:var(--zc-muted);border-color:transparent!important;text-decoration:underline;}
.zc-foot{border-top:1px solid var(--zc-border);padding:16px 18px;display:flex;flex-direction:column;gap:12px;}
.zc-foot-inline{border-top:1px solid var(--zc-border);margin-top:8px;padding:16px 0 0;}
.zc-totals{display:flex;flex-direction:column;gap:6px;font-size:14px;}
.zc-totals>div{display:flex;justify-content:space-between;}
.zc-totals .zc-muted{color:var(--zc-muted);}
.zc-ship-hint{margin:0;font-size:12px;color:var(--zc-muted);}
.zc-grand{font-weight:700;font-size:16px;border-top:1px dashed var(--zc-border);padding-top:8px;margin-top:2px;}
.zc-btn{border:1px solid var(--zc-border);background:var(--zc-surface);color:inherit;padding:12px 16px;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer;text-align:center;}
.zc-btn-primary{background:var(--zc-accent);color:var(--zc-accent-ink);border-color:var(--zc-accent);}
.zc-btn:disabled{opacity:.6;cursor:progress;}
.zc-form{display:flex;flex-direction:column;gap:12px;}
.zc-section{margin:6px 0 0;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--zc-muted);}
.zc-field{display:flex;flex-direction:column;gap:4px;font-size:13px;}
.zc-field>span{color:var(--zc-muted);}
.zc-field input,.zc-field textarea{border:1px solid var(--zc-border);border-radius:10px;padding:10px 12px;font:inherit;color:inherit;background:var(--zc-surface);width:100%;}
.zc-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.zc-pay{display:flex;gap:10px;align-items:center;border:1px solid var(--zc-accent);border-radius:12px;padding:12px;}
.zc-pay-dot{width:16px;height:16px;border-radius:999px;border:5px solid var(--zc-accent);flex:none;}
.zc-pay div{display:flex;flex-direction:column;}
.zc-pay span{font-size:12px;color:var(--zc-muted);}
.zc-done{text-align:center;align-items:center;display:flex;flex-direction:column;gap:10px;padding-top:36px;}
.zc-done-mark{width:64px;height:64px;border-radius:999px;background:var(--zc-accent);color:var(--zc-accent-ink);display:flex;align-items:center;justify-content:center;font-size:32px;}
.zc-done-thanks{margin:6px 0 0;font-size:16px;}
.zc-done-order{margin:0;font-size:22px;font-weight:700;}
.zc-done-total{margin:0 0 12px;color:var(--zc-muted);}
`;
