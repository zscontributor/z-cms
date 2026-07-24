"use client";

import { useState, useTransition } from "react";
import { discardFailedJobAction, retryFailedJobAction } from "@/app/actions/job";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Icon } from "@/components/shell/icon";
import type { FailedJobDto } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n-provider";

/** A stack trace is unreadable inline and indispensable when you need it. */
const REASON_PREVIEW = 120;

export function JobsTable({ jobs, locale }: { jobs: FailedJobDto[]; locale: string }) {
  const t = useT();
  const [target, setTarget] = useState<FailedJobDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function retry(job: FailedJobDto) {
    setError(null);
    setNotice(null);
    setBusyId(job.id);
    startTransition(async () => {
      const result = await retryFailedJobAction(job.id, job.name);
      setBusyId(null);
      if (!result.ok) setError(result.error);
      else setNotice(result.message);
    });
  }

  function confirmDiscard() {
    if (!target) return;
    const job = target;
    setError(null);
    setBusyId(job.id);
    startTransition(async () => {
      const result = await discardFailedJobAction(job.id, job.name);
      setBusyId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTarget(null);
      setNotice(result.message);
    });
  }

  return (
    <>
      {error ? (
        <p
          role="alert"
          className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {notice}
        </p>
      ) : null}

      <Table>
        <THead>
          <TR>
            <TH>{t("admin.jobs.colName")}</TH>
            <TH>{t("admin.jobs.colId")}</TH>
            <TH className="text-right">{t("admin.jobs.colAttempts")}</TH>
            <TH>{t("admin.jobs.colReason")}</TH>
            <TH>{t("admin.jobs.colFailedAt")}</TH>
            <TH className="text-right">{t("admin.jobs.colActions")}</TH>
          </TR>
        </THead>
        <TBody>
          {jobs.map((job) => {
            const busy = pending && busyId === job.id;
            return (
              <TR key={job.id}>
                <TD className="font-medium whitespace-nowrap">{job.name}</TD>
                <TD>
                  <code className="font-mono text-[11px] z-muted">{job.id}</code>
                </TD>
                <TD className="text-right tabular-nums">{job.attemptsMade}</TD>
                <TD className="min-w-64 max-w-md">
                  <FailureReason job={job} />
                </TD>
                <TD className="whitespace-nowrap text-xs z-muted">
                  {formatDateTime(job.failedAt, locale)}
                </TD>
                <TD>
                  <div className="flex items-center justify-end gap-2">
                    <Button size="sm" disabled={pending} onClick={() => retry(job)}>
                      <Icon name="retry" size={16} />
                      {busy ? t("common.working") : t("admin.jobs.retry")}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={pending}
                      onClick={() => {
                        setError(null);
                        setNotice(null);
                        setTarget(job);
                      }}
                    >
                      {t("admin.jobs.discard")}
                    </Button>
                  </div>
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>

      <Dialog
        open={target !== null}
        onClose={pending ? () => undefined : () => setTarget(null)}
        title={t("admin.jobs.discardDialog.title", { name: target?.name ?? "" })}
        footer={
          <>
            <Button type="button" disabled={pending} onClick={() => setTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={confirmDiscard}
            >
              {pending ? t("common.working") : t("admin.jobs.discardDialog.confirm")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-5">{t("admin.jobs.discardDialog.body")}</p>
          <p className="rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2 text-[11px] leading-4 z-muted">
            {t("admin.jobs.discardDialog.retryFirst")}
          </p>
          {target ? (
            <p className="text-[11px] z-muted">
              <code className="font-mono">{target.id}</code>
            </p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}

/**
 * A truncated reason, with the full text one click away.
 *
 * <details> rather than a state hook: the whole row is otherwise static, and the
 * browser already knows how to expand a disclosure.
 */
function FailureReason({ job }: { job: FailedJobDto }) {
  const t = useT();
  const reason = job.failedReason?.trim();

  if (!reason) {
    return <span className="text-[11px] z-muted">{t("admin.jobs.noReason")}</span>;
  }

  const long = reason.length > REASON_PREVIEW;

  return (
    <div className="min-w-0">
      <p className="truncate text-xs" title={reason}>
        {long ? `${reason.slice(0, REASON_PREVIEW)}…` : reason}
      </p>
      {long ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] text-brand-500">
            {t("admin.jobs.showFullReason")}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1.5 font-mono text-[10px] leading-4 whitespace-pre-wrap break-words">
            <code>{reason}</code>
          </pre>
        </details>
      ) : null}
    </div>
  );
}
