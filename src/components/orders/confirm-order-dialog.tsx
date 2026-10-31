"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PERU_DEPARTMENTS, validateOrderInput } from "@/lib/orders/fields";
import { buildPrefill, type OrderFormValues } from "@/lib/orders/prefill";

export interface OrderSeller {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: { id: string; name?: string | null; phone?: string | null };
  conversationId?: string | null;
  sellers: OrderSeller[];
}

type Step = "form" | "preview";

const FIELD_LABELS: { key: keyof OrderFormValues; label: string; optional?: boolean; multiline?: boolean }[] = [
  { key: "customer_name", label: "customerName" },
  { key: "phone", label: "phone" },
  { key: "dni", label: "dni", optional: true },
  { key: "product", label: "product", multiline: true },
  { key: "quantity", label: "quantity" },
  { key: "price", label: "price" },
  { key: "destination", label: "destination" },
  { key: "order_description", label: "orderDescription", optional: true, multiline: true },
];

// "Confirmar pedido". Opening the dialog starts ONE order: the `request_key` is generated here and reused by every submit of this dialog, so a
// double click, a slow network retry or a re-render can never create a second order. Closing and reopening starts a new one (a new sale).
export function ConfirmOrderDialog({ open, onOpenChange, contact, conversationId, sellers }: Props) {
  const t = useTranslations("Orders");
  const [step, setStep] = useState<Step>("form");
  const [values, setValues] = useState<OrderFormValues>(() => buildPrefill(contact, []));
  const [sellerId, setSellerId] = useState("");
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const requestKey = useRef<string>("");
  const inFlight = useRef(false);

  // Every opening is a new sale: fresh key, fresh pre-fill from the contact + its custom fields.
  useEffect(() => {
    if (!open) return;
    requestKey.current = crypto.randomUUID();
    inFlight.current = false;
    setStep("form");
    setSellerId("");
    setServerErrors({});
    setValues(buildPrefill(contact, []));
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("contact_custom_values")
        .select("value, custom_fields(field_name)")
        .eq("contact_id", contact.id);
      if (cancelled || !data) return;
      const rows = (data as unknown as { value: string | null; custom_fields: { field_name: string } | { field_name: string }[] | null }[])
        .map((r) => ({ field_name: (Array.isArray(r.custom_fields) ? r.custom_fields[0] : r.custom_fields)?.field_name ?? "", value: r.value }))
        .filter((r) => r.field_name);
      setValues((current) => {
        const filled = buildPrefill(contact, rows);
        // Never overwrite something the agent already typed while this was loading.
        return Object.fromEntries(
          (Object.keys(filled) as (keyof OrderFormValues)[]).map((k) => [k, current[k] && current[k] !== buildPrefill(contact, [])[k] ? current[k] : filled[k]]),
        ) as unknown as OrderFormValues;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contact]);

  const validation = useMemo(() => validateOrderInput(values), [values]);
  const errors = { ...(validation.errors as Record<string, string>), ...serverErrors };
  const canReview = validation.ok && sellerId !== "";

  const set = (key: keyof OrderFormValues, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setServerErrors((e) => ({ ...e, [key]: "" }));
  };

  async function submit() {
    // Hard guard against double activation, independent of the button's disabled state.
    if (inFlight.current || !validation.ok) return;
    inFlight.current = true;
    setSubmitting(true);
    try {
      const res = await fetch("/api/orders/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...values,
          request_key: requestKey.current,
          seller_id: sellerId,
          contact_id: contact.id,
          conversation_id: conversationId ?? undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(body.created === false ? t("alreadyToast") : t("confirmedToast"), {
          description: body.delivery_status === "held" ? t("heldHint") : t("queuedHint"),
        });
        onOpenChange(false);
        return; // inFlight stays true: this dialog session has already produced its order.
      }
      if (res.status === 422 && body.errors) {
        setServerErrors(body.errors);
        setStep("form");
        toast.error(t("errorValidation"));
      } else if (res.status === 422) {
        toast.error(t("errorReference"));
      } else {
        toast.error(t("errorGeneric"));
      }
      inFlight.current = false;
    } catch {
      toast.error(t("errorGeneric"));
      inFlight.current = false;
    } finally {
      setSubmitting(false);
    }
  }

  const sellerName = sellers.find((s) => s.id === sellerId)?.name ?? "";
  const err = (key: string) => (errors[key] ? t(`errors.${errors[key]}` as never) : null);

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{step === "form" ? t("title") : t("previewTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {step === "form" ? (
          <div className="grid gap-3">
            {FIELD_LABELS.map(({ key, label, optional, multiline }) => (
              <div key={key} className="grid gap-1">
                <Label htmlFor={`order-${key}`}>
                  {t(label as never)}
                  {optional ? <span className="ml-1 text-muted-foreground">({t("optional")})</span> : null}
                </Label>
                {multiline ? (
                  <Textarea id={`order-${key}`} rows={2} value={values[key]} onChange={(e) => set(key, e.target.value)} aria-invalid={!!err(key)} />
                ) : (
                  <Input
                    id={`order-${key}`}
                    value={values[key]}
                    inputMode={key === "price" || key === "quantity" || key === "phone" || key === "dni" ? "decimal" : undefined}
                    onChange={(e) => set(key, e.target.value)}
                    aria-invalid={!!err(key)}
                  />
                )}
                {err(key) ? <p className="text-xs text-destructive">{err(key)}</p> : null}
                {key === "dni" && validation.warnings.dni ? <p className="text-xs text-muted-foreground">{t("warningDni")}</p> : null}
              </div>
            ))}

            <div className="grid gap-1">
              <Label htmlFor="order-department">
                {t("department")} <span className="text-muted-foreground">({t("optional")})</span>
              </Label>
              <select
                id="order-department"
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={values.department}
                onChange={(e) => set("department", e.target.value)}
              >
                <option value="">{t("departmentPlaceholder")}</option>
                {PERU_DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              {err("department") ? <p className="text-xs text-destructive">{err("department")}</p> : null}
            </div>

            <div className="grid gap-1">
              <Label htmlFor="order-seller">{t("seller")}</Label>
              <select
                id="order-seller"
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={sellerId}
                onChange={(e) => setSellerId(e.target.value)}
              >
                <option value="">{t("sellerPlaceholder")}</option>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("cancel")}
              </Button>
              <Button disabled={!canReview} onClick={() => setStep("preview")}>
                {t("review")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid gap-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="order-preview">
              {validation.value
                ? ([
                    ["customerName", validation.value.customer_name],
                    ["phone", validation.value.phone],
                    ["dni", validation.value.dni || "—"],
                    ["product", validation.value.product],
                    ["quantity", String(validation.value.quantity)],
                    ["price", `S/ ${validation.value.price}`],
                    ["orderDescription", validation.value.order_description || "—"],
                    ["agency", validation.value.agency],
                    ["destination", validation.value.destination],
                    ["department", validation.value.department || "—"],
                    ["seller", sellerName],
                  ] as [string, string][]).map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-muted-foreground">{t(label as never)}</dt>
                      <dd className="whitespace-pre-line break-words">{value}</dd>
                    </div>
                  ))
                : null}
            </dl>
            <p className="text-xs text-muted-foreground">{t("previewConfirmedAt")} · {t("previewStatus")}</p>
            <DialogFooter>
              <Button variant="outline" disabled={submitting} onClick={() => setStep("form")}>
                {t("back")}
              </Button>
              <Button disabled={submitting} onClick={submit}>
                {submitting ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
                {submitting ? t("confirming") : t("confirm")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
