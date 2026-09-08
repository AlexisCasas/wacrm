"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Languages, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { normalizeLocale, type AppLocale } from "@/i18n/config";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Language panel — per-user interface language (P1, migration 045).
 *
 * Deliberately NOT gated behind `canEditSettings`: unlike currency or
 * WhatsApp config, this is a personal preference exactly like
 * Appearance — every authenticated role (owner/admin/agent/viewer)
 * may change their OWN language. Writes go straight to
 * `profiles.locale` scoped by the caller's own `user_id`; the
 * existing `profiles_update` RLS policy already allows any
 * authenticated user to update their own row, and migration 034's
 * privilege trigger only guards `account_id`/`account_role`, so this
 * needs no new policy or endpoint.
 *
 * Saving triggers a full reload rather than just updating local state
 * — src/i18n/request.ts resolves the page's locale server-side per
 * request, so only a fresh request (not a client-side state update)
 * makes RootLayout re-render with the new messages/`<html lang>`.
 */
export function LanguagePanel() {
  const supabase = createClient();
  const { user, profile, profileLoading } = useAuth();
  const t = useTranslations("Settings.language");

  const currentLocale: AppLocale = profile?.locale ?? "es";
  const [selected, setSelected] = useState<AppLocale>(currentLocale);
  const [saving, setSaving] = useState(false);

  // Keep the select in sync once the profile resolves.
  useEffect(() => {
    setSelected(currentLocale);
  }, [currentLocale]);

  const dirty = selected !== currentLocale;

  async function handleSave() {
    if (!user?.id || !dirty || saving) return;
    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({ locale: selected })
      .eq("user_id", user.id);
    if (error) {
      toast.error(t("saveFailed"));
      setSaving(false);
      return;
    }
    toast.success(t("saveSuccess"));
    // Deliberate, controlled full reload — never require the user to
    // press F5 themselves, and never just flip client state, since
    // the server-rendered locale/messages need a fresh request.
    window.location.reload();
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Languages className="size-4 text-primary" />
            {t("interfaceLanguage")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:max-w-xs">
            <Label className="text-muted-foreground">
              {t("interfaceLanguage")}
            </Label>
            <select
              value={selected}
              onChange={(e) => setSelected(normalizeLocale(e.target.value))}
              disabled={profileLoading || saving}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="es">🇪🇸 {t("es")}</option>
              <option value="en">🇺🇸 {t("en")}</option>
            </select>
          </div>

          <Button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("saving")}
              </>
            ) : (
              t("save")
            )}
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
