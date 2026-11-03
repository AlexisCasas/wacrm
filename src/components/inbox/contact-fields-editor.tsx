"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Save, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { changedCustomFieldIds } from "@/lib/contacts/field-diff";
import type { Contact, CustomField } from "@/types";

type StandardValues = { name: string; email: string; company: string };
type FieldDefinition = Pick<CustomField, "id" | "field_name" | "field_type">;
type StoredValue = { id: string; custom_field_id: string; value: string | null };
type StoredByField = Record<string, StoredValue>;

function initialStandard(contact: Contact): StandardValues {
  return {
    name: contact.name ?? "",
    email: contact.email ?? "",
    company: contact.company ?? "",
  };
}

function clean(value: string): string {
  return value.trim();
}

function normalizedSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

interface InboxContactFieldsProps {
  contact: Contact;
  onContactUpdated?: (contact: Contact) => void;
}

/**
 * In-place editor in the Inbox sidebar. Definitions remain admin-managed;
 * agents edit VALUES only. Phone/WA identity is deliberately read-only here.
 * Uses the existing account-scoped RLS, no service-role or new endpoint.
 */
export function InboxContactFields({ contact, onContactUpdated }: InboxContactFieldsProps) {
  const t = useTranslations("Inbox.sidebar");
  const { accountId, canSendMessages } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [standard, setStandard] = useState<StandardValues>(() => initialStandard(contact));
  const [savedStandard, setSavedStandard] = useState<StandardValues>(() => initialStandard(contact));
  const [dbContact, setDbContact] = useState<Contact | null>(null);
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedValues, setSavedValues] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<StoredByField>({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [savingStandard, setSavingStandard] = useState(false);
  const [savingCustom, setSavingCustom] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      try {
      const [contactRes, fieldsRes, valuesRes] = await Promise.all([
        supabase.from("contacts")
          .select("id, account_id, name, phone, email, company, wa_username, phone_optional, updated_at")
          .eq("id", contact.id)
          .eq("account_id", accountId)
          .maybeSingle(),
        supabase.from("custom_fields")
          .select("id, field_name, field_type")
          .eq("account_id", accountId)
          .order("field_name"),
        supabase.from("contact_custom_values")
          .select("id, custom_field_id, value")
          .eq("contact_id", contact.id),
      ]);
      if (cancelled) return;
      if (contactRes.error || fieldsRes.error || valuesRes.error || !contactRes.data) {
        setLoadError(true);
        setLoading(false);
        return;
      }

      const fresh = { ...contact, ...contactRes.data } as Contact;
      const base = initialStandard(fresh);
      const savedRows = (valuesRes.data ?? []) as StoredValue[];
      const original: Record<string, string> = {};
      const byField: StoredByField = {};
      for (const row of savedRows) {
        original[row.custom_field_id] = row.value ?? "";
        byField[row.custom_field_id] = row;
      }
      setDbContact(fresh);
      setStandard(base);
      setSavedStandard(base);
      setFields((fieldsRes.data ?? []) as FieldDefinition[]);
      setValues(original);
      setSavedValues(original);
      setStored(byField);
      setLoadError(false);
      setLoading(false);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
    // The component is keyed by contact.id in the sidebar, so any pending
    // response for a previous contact is discarded on unmount.
  }, [accountId, contact.id, reload, supabase]);

  const dirtyStandard = (Object.keys(standard) as (keyof StandardValues)[])
    .some((key) => clean(standard[key]) !== savedStandard[key]);
  const dirtyCustomIds = changedCustomFieldIds(fields, values, savedValues);
  const filtered = useMemo(() => fields.filter((field) =>
    normalizedSearch(field.field_name).includes(normalizedSearch(search)),
  ), [fields, search]);

  function refresh() {
    if (savingStandard || savingCustom) return;
    // Explicit action: discards unsaved edits and rereads both sources.
    setLoading(true);
    setLoadError(false);
    setSearch("");
    setReload((n) => n + 1);
  }

  async function saveStandard() {
    if (!canSendMessages || !accountId || !dbContact || !dirtyStandard || savingStandard) return;
    const patch: Record<string, string | null> = {};
    for (const key of Object.keys(standard) as (keyof StandardValues)[]) {
      if (clean(standard[key]) !== savedStandard[key]) {
        patch[key] = clean(standard[key]) || null;
      }
    }
    if (Object.keys(patch).length === 0) return;
    setSavingStandard(true);
    try {
      const { data, error } = await supabase.from("contacts")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", contact.id)
        .eq("account_id", accountId)
        // Do not silently overwrite another edit made since the panel loaded.
        .eq("updated_at", dbContact.updated_at)
        .select("id, name, email, company, updated_at")
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        toast.error(t("fieldsConflict"));
        return;
      }
      const updated = { ...dbContact, ...data } as Contact;
      const saved = initialStandard(updated);
      setDbContact(updated);
      setStandard(saved);
      setSavedStandard(saved);
      onContactUpdated?.(updated);
      toast.success(t("fieldsSaved"));
    } catch {
      toast.error(t("fieldsSaveError"));
    } finally {
      setSavingStandard(false);
    }
  }

  async function saveCustom() {
    if (!canSendMessages || !accountId || savingCustom || dirtyCustomIds.length === 0) return;
    setSavingCustom(true);
    try {
      for (const fieldId of dirtyCustomIds) {
        const next = clean(values[fieldId] ?? "");
        const oldRow = stored[fieldId];
        if (oldRow) {
          // Optimistic compare-and-set: another agent or flow that changed
          // this exact value since load wins, rather than being overwritten.
          if (next) {
            let query = supabase.from("contact_custom_values")
              .update({ value: next })
              .eq("id", oldRow.id)
              .eq("contact_id", contact.id)
              .eq("custom_field_id", fieldId);
            query = oldRow.value === null ? query.is("value", null) : query.eq("value", oldRow.value);
            const { data, error } = await query.select("id, custom_field_id, value").maybeSingle();
            if (error) throw error;
            if (!data) throw new Error("contact_custom_value_changed");
            setStored((prev) => ({ ...prev, [fieldId]: data as StoredValue }));
          } else {
            let query = supabase.from("contact_custom_values")
              .delete()
              .eq("id", oldRow.id)
              .eq("contact_id", contact.id)
              .eq("custom_field_id", fieldId);
            query = oldRow.value === null ? query.is("value", null) : query.eq("value", oldRow.value);
            const { data, error } = await query.select("id").maybeSingle();
            if (error) throw error;
            if (!data) throw new Error("contact_custom_value_changed");
            setStored((prev) => {
              const copy = { ...prev };
              delete copy[fieldId];
              return copy;
            });
          }
        } else if (next) {
          // Plain INSERT, not UPSERT: a concurrent insertion must fail
          // rather than overwrite the value entered by another agent.
          const { data, error } = await supabase.from("contact_custom_values")
            .insert({ contact_id: contact.id, custom_field_id: fieldId, value: next })
            .select("id, custom_field_id, value")
            .single();
          if (error || !data) throw error ?? new Error("insert_failed");
          setStored((prev) => ({ ...prev, [fieldId]: data as StoredValue }));
        }
        // Commit the successful field to the local baseline immediately.
        // If a later field fails, earlier successful writes remain visible
        // and only unsaved fields are still dirty.
        setSavedValues((prev) => ({ ...prev, [fieldId]: next }));
        setValues((prev) => ({ ...prev, [fieldId]: next }));
      }
      toast.success(t("fieldsSaved"));
    } catch (error) {
      const conflict = error instanceof Error && error.message === "contact_custom_value_changed";
      const unique = typeof error === "object" && error !== null && "code" in error && error.code === "23505";
      toast.error(t(conflict || unique ? "fieldsConflict" : "fieldsSaveError"));
    } finally {
      setSavingCustom(false);
    }
  }

  const canEdit = Boolean(accountId && canSendMessages);

  if (loading) {
    return (
      <div className="flex justify-center py-5" role="status">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-2 py-2">
        <p className="text-xs text-destructive">{t("fieldsLoadError")}</p>
        <Button type="button" variant="outline" size="sm" onClick={refresh}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          {t("fieldsReload")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{t("fieldsStandard")}</p>
        <button type="button" onClick={refresh} disabled={savingCustom || savingStandard}
          className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
          title={t("fieldsReload")} aria-label={t("fieldsReload")}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      {(["name", "email", "company"] as const).map((key) => (
        <label key={key} className="block space-y-1">
          <span className="text-xs text-muted-foreground">
            {t(key === "name" ? "fieldsName" : key === "email" ? "fieldsEmail" : "fieldsCompany")}
          </span>
          <Input value={standard[key]} disabled={!canEdit || savingStandard}
            className="h-8 bg-muted text-sm" onChange={(event) =>
              setStandard((prev) => ({ ...prev, [key]: event.target.value }))
            } />
        </label>
      ))}
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t("fieldsPhone")}</span>
        <Input value={dbContact?.phone || dbContact?.wa_username || ""} readOnly
          className="h-8 bg-muted text-sm opacity-75" title={t("fieldsPhoneReadOnly")} />
        <span className="block text-[10px] text-muted-foreground">{t("fieldsPhoneReadOnly")}</span>
      </label>
      {canEdit && (
        <Button type="button" size="sm" className="w-full" onClick={saveStandard}
          disabled={!dirtyStandard || savingStandard || savingCustom}>
          {savingStandard ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> :
            <Save className="mr-1 h-3.5 w-3.5" />}
          {t("fieldsSaveStandard")}
        </Button>
      )}

      <div className="border-t border-border pt-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("fieldsCustom")}</p>
        {fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("fieldsNone")}</p>
        ) : (
          <>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)}
                placeholder={t("fieldsSearch")} aria-label={t("fieldsSearch")}
                className="h-8 pl-7 text-xs" />
            </div>
            <div className="space-y-2">
              {filtered.length === 0 && <p className="text-xs text-muted-foreground">{t("fieldsNoMatches")}</p>}
              {filtered.map((field) => (
                <label key={field.id} className="block space-y-1">
                  <span className="block break-words text-xs text-muted-foreground">{field.field_name}</span>
                  <Input value={values[field.id] ?? ""} disabled={!canEdit || savingCustom}
                    className="h-8 bg-muted text-sm"
                    onChange={(event) => setValues((prev) => ({ ...prev, [field.id]: event.target.value }))} />
                </label>
              ))}
            </div>
            {canEdit && (
              <Button type="button" size="sm" className="mt-3 w-full" onClick={saveCustom}
                disabled={dirtyCustomIds.length === 0 || savingCustom || savingStandard}>
                {savingCustom ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> :
                  <Save className="mr-1 h-3.5 w-3.5" />}
                {t("fieldsSaveCustom")}
              </Button>
            )}
          </>
        )}
      </div>
      {!canEdit && <p className="text-xs text-muted-foreground">{t("fieldsReadOnly")}</p>}
      {(dirtyStandard || dirtyCustomIds.length > 0) && canEdit && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400" role="status">
          {t("fieldsUnsaved")}
        </p>
      )}
    </div>
  );
}
