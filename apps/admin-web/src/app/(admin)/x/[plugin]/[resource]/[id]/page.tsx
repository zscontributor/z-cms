import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError, getPluginRow, getSession } from "@/lib/api";
import type { PluginResourceDescriptor, PluginRow } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { getLocale, getT } from "@/lib/locale";
import { formatCell } from "../format-cell";
import { SYSTEM_COLUMNS, detailFields } from "../detail-fields";
import { RecordActions } from "./record-actions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ plugin: string; resource: string; id: string }>;
}

/**
 * One record of a plugin resource.
 *
 * The list screen has always linked to nothing: a row's whole story was reachable
 * only by opening the edit form, which shows what the plugin made editable rather
 * than what the record says, and which a read-only role cannot open at all. This is
 * the read screen — gated by the resource's read permission, like the list — with
 * edit and delete offered to whoever also holds the write permission.
 */
export default async function PluginRecordPage({ params }: PageProps) {
  const { plugin, resource, id } = await params;
  const t = await getT();
  const locale = await getLocale();
  const user = await getSession();

  let data: { resource: PluginResourceDescriptor; row: PluginRow };
  try {
    data = await getPluginRow(plugin, resource, id);
  } catch (error) {
    // 403/404 alike: not permitted, not installed, no such row — from the reader's
    // point of view all three are "this record is not here".
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) notFound();
    throw error;
  }

  const descriptor = data.resource;
  const row = data.row;
  const fields = detailFields(descriptor);
  const listPath = `/x/${encodeURIComponent(plugin)}/${encodeURIComponent(resource)}`;
  const canWrite = Boolean(
    descriptor.permissions.write && user?.permissions.includes(descriptor.permissions.write),
  );

  // The most identifying thing the plugin chose to list, used as the page title so
  // the browser tab and the back-stack say which record this is — a uuid would not.
  const headline = descriptor.list.columns[0]
    ? formatCell(row[descriptor.list.columns[0].column], locale)
    : t("plugins.resource.detailTitle");

  return (
    <>
      <PageHeader
        title={headline === "—" ? t("plugins.resource.detailTitle") : headline}
        description={descriptor.label}
        actions={
          <Link href={listPath} className="text-sm z-muted hover:underline">
            ← {t("plugins.resource.back")}
          </Link>
        }
      />

      <div className="flex flex-col gap-4">
        {canWrite && descriptor.form ? (
          <RecordActions
            pluginKey={plugin}
            resourceKey={resource}
            listPath={listPath}
            fields={descriptor.form.fields}
            row={row}
            labels={{
              edit: t("common.edit"),
              delete: t("common.delete"),
              save: t("common.save"),
              cancel: t("common.cancel"),
              confirmDelete: t("common.confirmDelete"),
            }}
          />
        ) : null}

        <section className="z-card p-5">
          <h2 className="mb-3 text-sm font-semibold">{t("plugins.resource.fields")}</h2>
          <dl className="divide-y divide-[var(--border)]">
            {fields.map((field) => (
              <div key={field.column} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-4">
                <dt className="text-[13px] z-muted">{field.label}</dt>
                <dd className="min-w-0 text-sm">
                  <Value value={row[field.column]} input={field.input} locale={locale} empty={t("plugins.resource.emptyValue")} markupLabel={t("plugins.resource.markup")} />
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="z-card p-5">
          <h2 className="mb-3 text-sm font-semibold">{t("plugins.resource.system")}</h2>
          <dl className="divide-y divide-[var(--border)]">
            {SYSTEM_COLUMNS.map((column) => (
              <div key={column} className="grid gap-1 py-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-4">
                <dt className="text-[13px] z-muted">
                  {column === "id"
                    ? t("plugins.resource.id")
                    : column === "created_at"
                      ? t("plugins.resource.createdAt")
                      : t("plugins.resource.updatedAt")}
                </dt>
                <dd className="min-w-0 break-all font-mono text-[12px]">
                  {formatCell(row[column], locale)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </>
  );
}

/**
 * One value, rendered by what the plugin said the field IS rather than by what the
 * string looks like — the one place a detail screen can do better than the list.
 *
 * A `richtext` value is shown as its markup, escaped, and not rendered as HTML.
 * That is deliberate: a plugin's row can be written by its own sandboxed code as
 * well as through this form, nothing sanitises it on the way in (unlike block
 * richtext, which cms-api sanitises), and admin-web carries no sanitiser of its
 * own. Rendering it would make a plugin's table a stored-XSS surface inside the
 * admin. Showing the markup is honest and costs nobody anything today: no
 * first-party plugin declares a richtext field.
 */
function Value({
  value,
  input,
  locale,
  empty,
  markupLabel,
}: {
  value: unknown;
  input?: string;
  locale: string;
  empty: string;
  markupLabel: string;
}) {
  if (value === null || value === undefined || value === "") {
    return <span className="z-muted">{empty}</span>;
  }

  if (input === "richtext") {
    return (
      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide z-muted">{markupLabel}</p>
        <pre className="max-h-72 overflow-auto rounded-md bg-[var(--surface-sunken)] p-3 text-[12px] whitespace-pre-wrap break-words">
          {String(value)}
        </pre>
      </div>
    );
  }

  if (input === "textarea") {
    // Kept as typed: a clinician's note is written in lines, and collapsing them
    // turns a list of symptoms into one paragraph.
    return <p className="whitespace-pre-wrap break-words">{String(value)}</p>;
  }

  return <span className="break-words">{formatCell(value, locale)}</span>;
}
