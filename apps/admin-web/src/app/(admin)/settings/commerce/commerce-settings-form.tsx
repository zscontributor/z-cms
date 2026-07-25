"use client";

import { useActionState } from "react";
import type { CommerceSettingsDto } from "@zcmsorg/schemas";
import { saveCommerceSettingsAction, type OrderActionResult } from "@/app/actions/orders";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { useT } from "@/lib/i18n-provider";

type State = OrderActionResult | null;

const save = async (_prev: State, formData: FormData): Promise<State> =>
  saveCommerceSettingsAction(formData);

export function CommerceSettingsForm({
  settings,
  disabled,
  locale: _locale,
}: {
  settings: CommerceSettingsDto;
  disabled: boolean;
  locale: string;
}) {
  const t = useT();
  const [state, action] = useActionState(save, null);

  return (
    <form action={action} className="z-card max-w-2xl space-y-5 p-5">
      <label className="flex items-start gap-2.5">
        <Checkbox name="enabled" defaultChecked={settings.enabled} disabled={disabled} />
        <span>
          <span className="text-sm font-medium">{t("commerce.settings.enabled")}</span>
          <span className="block text-[11px] z-muted">{t("commerce.settings.enabledHint")}</span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("commerce.settings.currency")} hint={t("commerce.settings.currencyHint")} htmlFor="currency" required>
          <Input
            id="currency"
            name="currency"
            defaultValue={settings.currency}
            maxLength={3}
            disabled={disabled}
            required
          />
        </Field>
        <Field label={t("commerce.settings.shippingFee")} hint={t("commerce.settings.shippingFeeHint")} htmlFor="shippingFlatFee">
          <Input
            id="shippingFlatFee"
            name="shippingFlatFee"
            type="number"
            min={0}
            step="0.01"
            defaultValue={settings.shippingFlatFee}
            disabled={disabled}
          />
        </Field>
      </div>

      <Field label={t("commerce.settings.freeShipping")} hint={t("commerce.settings.freeShippingHint")} htmlFor="freeShippingThreshold">
        <Input
          id="freeShippingThreshold"
          name="freeShippingThreshold"
          type="number"
          min={0}
          step="0.01"
          defaultValue={settings.freeShippingThreshold ?? ""}
          disabled={disabled}
        />
      </Field>

      <label className="flex items-start gap-2.5">
        <Checkbox name="codEnabled" defaultChecked={settings.codEnabled} disabled={disabled} />
        <span>
          <span className="text-sm font-medium">{t("commerce.settings.cod")}</span>
          <span className="block text-[11px] z-muted">{t("commerce.settings.codHint")}</span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("commerce.settings.storeName")} htmlFor="storeName">
          <Input id="storeName" name="storeName" defaultValue={settings.storeName ?? ""} disabled={disabled} />
        </Field>
        <Field label={t("commerce.settings.storeEmail")} hint={t("commerce.settings.storeEmailHint")} htmlFor="storeEmail">
          <Input
            id="storeEmail"
            name="storeEmail"
            type="email"
            defaultValue={settings.storeEmail ?? ""}
            disabled={disabled}
          />
        </Field>
      </div>

      {state?.ok === false ? (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      ) : state?.ok ? (
        <p className="text-sm text-green-600 dark:text-green-400">{state.message}</p>
      ) : null}

      {!disabled ? <SubmitButton variant="primary">{t("commerce.settings.save")}</SubmitButton> : null}
    </form>
  );
}
