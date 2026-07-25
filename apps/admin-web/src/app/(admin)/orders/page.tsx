import type { Metadata } from "next";
import Link from "next/link";
import { OrderStatusSchema } from "@zcmsorg/schemas";
import { can, getSession, listOrders } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { EmptyState, TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import {
  ORDER_STATUS_TONES,
  PAYMENT_STATUS_TONES,
  formatDateTime,
  formatMoney,
  orderStatusKey,
  paymentStatusKey,
} from "@/lib/format";
import { getLocale, getT } from "@/lib/locale";
import { OrderToolbar } from "./order-toolbar";

export const dynamic = "force-dynamic";

const PER_PAGE = 20;

interface PageProps {
  searchParams: Promise<{ page?: string; status?: string; q?: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("commerce.metaTitle") };
}

export default async function OrdersPage({ searchParams }: PageProps) {
  const { page: pageParam, status: statusParam, q } = await searchParams;
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();

  if (!can(user, "order:read")) {
    return <div className="z-card p-10 text-center text-sm">{t("commerce.list.denied")}</div>;
  }

  const page = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);
  const status = OrderStatusSchema.safeParse(statusParam).success ? statusParam : undefined;

  const result = await listOrders({ status, q, page, perPage: PER_PAGE });

  return (
    <>
      <PageHeader title={t("commerce.list.title")} description={t("commerce.list.description")} />

      <OrderToolbar />

      {result.items.length === 0 ? (
        <div className="z-card">
          <EmptyState
            title={q || status ? t("commerce.list.noResultsTitle") : t("commerce.list.emptyTitle")}
            description={
              q || status
                ? t("commerce.list.noResultsDescription")
                : t("commerce.list.emptyDescription")
            }
          />
        </div>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>{t("commerce.table.order")}</TH>
                <TH>{t("commerce.table.customer")}</TH>
                <TH className="w-20 text-right">{t("commerce.table.items")}</TH>
                <TH className="w-32 text-right">{t("commerce.table.total")}</TH>
                <TH className="w-44">{t("commerce.table.status")}</TH>
                <TH className="w-40">{t("commerce.table.placed")}</TH>
              </TR>
            </THead>
            <TBody>
              {result.items.map((order) => (
                <TR key={order.id}>
                  <TD>
                    <Link
                      href={`/orders/${order.id}`}
                      className="font-medium hover:text-brand-600 dark:hover:text-brand-400"
                    >
                      #{order.orderNumber}
                    </Link>
                  </TD>
                  <TD>{order.customerName}</TD>
                  <TD className="text-right tabular-nums">{order.itemCount}</TD>
                  <TD className="text-right font-medium tabular-nums">
                    {formatMoney(order.total, order.currency, locale)}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={ORDER_STATUS_TONES[order.status]}>
                        {t(orderStatusKey(order.status))}
                      </Badge>
                      <Badge tone={PAYMENT_STATUS_TONES[order.paymentStatus]}>
                        {t(paymentStatusKey(order.paymentStatus))}
                      </Badge>
                    </div>
                  </TD>
                  <TD className="text-[11px] z-muted">{formatDateTime(order.placedAt, locale)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>

          <Pagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            basePath="/orders"
            query={{ q, status }}
          />
        </>
      )}
    </>
  );
}
