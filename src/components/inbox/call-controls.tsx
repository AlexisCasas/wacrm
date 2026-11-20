"use client";

import { useEffect, useState } from "react";
import { Loader2, Phone, PhoneCall, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";

interface CallPermission {
  status: "no_permission" | "temporary" | "permanent";
  expirationTime?: number;
  canStartCall: boolean;
  canRequestPermission: boolean;
}

interface CallControlsProps {
  contactId: string;
  conversationId: string;
  contactName: string;
  disabled?: boolean;
  callBusy?: boolean;
  onStartCall: (input: {
    contactId: string;
    conversationId: string;
    contactName: string;
  }) => Promise<boolean>;
}

async function postCallAction(body: Record<string, unknown>) {
  const response = await fetch("/api/whatsapp/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
  }
  return payload as { permission?: CallPermission; message_id?: string };
}

function hasCurrentPermission(permission: CallPermission | null): boolean {
  if (!permission?.canStartCall) return false;
  if (permission.status === "permanent") return true;
  return permission.status === "temporary"
    && typeof permission.expirationTime === "number"
    && permission.expirationTime * 1000 > Date.now();
}

export function CallControls({
  contactId,
  conversationId,
  contactName,
  disabled = false,
  callBusy = false,
  onStartCall,
}: CallControlsProps) {
  const t = useTranslations("Inbox.callControls");
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<CallPermission | null>(null);
  const [loadingPermission, setLoadingPermission] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState(false);
  const [startingCall, setStartingCall] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingPermission(true);
    setPermission(null);
    setMessage(null);
    postCallAction({ action: "check_permission", contact_id: contactId })
      .then((payload) => {
        if (!cancelled) setPermission(payload.permission ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : t("permissionCheckFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoadingPermission(false);
      });
    return () => { cancelled = true; };
  }, [open, contactId, t]);

  const requestPermission = async () => {
    setRequestingPermission(true);
    setMessage(null);
    try {
      await postCallAction({ action: "request_permission", contact_id: contactId });
      setMessage(t("permissionRequestSent"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("permissionRequestFailed"));
    } finally {
      setRequestingPermission(false);
    }
  };

  const startCall = async () => {
    setStartingCall(true);
    setMessage(null);
    try {
      const started = await onStartCall({ contactId, conversationId, contactName });
      if (started) setOpen(false);
    } finally {
      setStartingCall(false);
    }
  };

  const permissionReady = hasCurrentPermission(permission);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || callBusy}
        onClick={() => setOpen(true)}
        title={t("call")}
        aria-label={t("call")}
        data-testid="inbox-start-call"
      >
        {callBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Phone className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{t("call")}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("callContactTitle", { name: contactName })}</DialogTitle>
            <DialogDescription>{t("callContactDescription")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-sm">
              <PhoneCall className="h-4 w-4 text-primary" />
              <span className="font-medium">{t("permissionStatus")}</span>
            </div>
            {loadingPermission ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("checkingPermission")}
              </p>
            ) : permissionReady ? (
              <p className="text-xs text-emerald-500">
                {permission?.status === "permanent" ? t("permissionPermanent") : t("permissionTemporary")}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t("permissionMissing")}</p>
            )}
            <p className="text-xs text-muted-foreground">{t("microphoneNotice")}</p>
          </div>

          {message && (
            <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {message}
            </p>
          )}

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={startingCall || requestingPermission}>
              {t("cancel")}
            </Button>
            {!loadingPermission && permissionReady && (
              <Button type="button" onClick={() => void startCall()} disabled={startingCall || callBusy}>
                {startingCall ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Phone className="mr-1.5 h-3.5 w-3.5" />}
                {t("startCall")}
              </Button>
            )}
            {!loadingPermission && !permissionReady && permission?.canRequestPermission && (
              <Button type="button" onClick={() => void requestPermission()} disabled={requestingPermission}>
                {requestingPermission ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="mr-1.5 h-3.5 w-3.5" />}
                {t("requestPermission")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
