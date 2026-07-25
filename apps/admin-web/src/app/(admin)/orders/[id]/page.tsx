import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, getOrder, getSession } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import {
  ORDER_STATUS_TONES,
  PAYMENT_STATUS_TONES,
  formatDateTime,
  formatMoney,
  orderStatusKey,
  paymentStatusKey,
} from "@/lib/format";
import { getLocale, getT } from "@/lib/locale";
import { OrderStatusForm } from "./order-status-form";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const t = await getT();
  try {
    const order = await getOrder(id);
    return { title: `${t("commerce.detail.metaTitle")} #${order.orderNumber}` };
  } catch {
    return { title: t("commerce.detail.metaTitle") };
  }
}

export default async function OrderDetailPage({ params }: PageProps) {
  const { id } = await params;
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();

  if (!can(user, "order:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("commerce.list.denied")}</div>;
  }

  let order;
  try {
    order = await getOrder(id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const money = (value: number) => formatMoney(value, order.currency, locale);
  const canManage = can(user, "order:manage");

  return (
    <>
      <PageHeader
        title={`#${order.orderNumber}`}
        description={formatDateTime(order.placedAt, locale)}
        actions={
          <Link href="/orders" className="text-sm z-muted hover:underline">
            ← {t("commerce.detail.back")}
          </Link>
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <Badge tone={ORDER_STATUS_TONES[order.status]}>{t(orderStatusKey(order.status))}</Badge>
        <Badge tone={PAYMENT_STATUS_TONES[order.paymentStatus]}>
          {t(paymentStatusKey(order.paymentStatus))}
        </Badge>
        <Badge tone="neutral">{t(`commerce.paymentMethod.${order.paymentMethod}`)}</Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="z-card p-5">
          <h2 className="mb-3 text-sm font-semibold">{t("commerce.detail.items")}</h2>
          <ul className="divide-y divide-[var(--border)]">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-3">
                <div className="flex size-11 flex-none items-center justify-center overflow-hidden rounded-md bg-[var(--surface-sunken)] text-lg">
                  {item.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image} alt="" className="size-full object-cover" />
                  ) : (
                    <span aria-hidden="true">🧴</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="text-[11px] z-muted">
                    {money(item.unitPrice)} × {item.quantity}
                  </p>
                </div>
                <div className="text-sm font-medium tabular-nums">{money(item.lineTotal)}</div>
              </li>
            ))}
          </ul>

          <dl className="mt-4 space-y-1.5 border-t border-[var(--border)] pt-4 text-sm">
            <Row label={t("commerce.detail.subtotal")} value={money(order.subtotal)} />
            <Row
              label={t("commerce.detail.shippingFee")}
              value={order.shippingFee === 0 ? t("commerce.detail.free") : money(order.shippingFee)}
            />
            {order.discountTotal > 0 ? (
              <Row label={t("commerce.detail.discount")} value={`- ${money(order.discountTotal)}`} />
            ) : null}
            <div className="flex justify-between border-t border-dashed border-[var(--border)] pt-2 text-base font-semibold">
              <dt>{t("commerce.detail.total")}</dt>
              <dd className="tabular-nums">{money(order.total)}</dd>
            </div>
          </dl>
        </div>

        <div className="space-y-4">
          <div className="z-card p-5">
            <h2 className="mb-3 text-sm font-semibold">{t("commerce.detail.customer")}</h2>
            <p className="text-sm font-medium">{order.customer.name}</p>
            <p className="text-[13px] z-muted">{order.customer.email}</p>
            <p className="text-[13px] z-muted">{order.customer.phone}</p>
            <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide z-muted">
              {t("commerce.detail.shipping")}
            </h3>
            <p className="mt-1 text-[13px]">{order.customer.address}</p>
            <p className="text-[13px]">{order.customer.city}</p>
            {order.note ? (
              <>
                <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide z-muted">
                  {t("commerce.detail.note")}
                </h3>
                <p className="mt-1 text-[13px]">{order.note}</p>
              </>
            ) : null}
          </div>

          {canManage ? <OrderStatusForm id={order.id} status={order.status} /> : null}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="z-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
