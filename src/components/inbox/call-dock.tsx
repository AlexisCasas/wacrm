"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Volume2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";
import type {
  ActiveCallingSession,
  CallingCallRecord,
} from "@/hooks/use-whatsapp-calling";

interface CallDockProps {
  incomingCalls: CallingCallRecord[];
  activeCall: ActiveCallingSession | null;
  remoteStream: MediaStream | null;
  muted: boolean;
  busy: boolean;
  error: string | null;
  onAccept: (call: CallingCallRecord) => void;
  onReject: (call: CallingCallRecord) => void;
  onEnd: () => void;
  onToggleMute: () => void;
  onClearError: () => void;
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60).toString().padStart(2, "0");
  const remainder = (safe % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function CallDock({
  incomingCalls,
  activeCall,
  remoteStream,
  muted,
  busy,
  error,
  onAccept,
  onReject,
  onEnd,
  onToggleMute,
  onClearError,
}: CallDockProps) {
  const t = useTranslations("Inbox.callControls");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = remoteStream;
    if (!remoteStream) {
      setAudioBlocked(false);
      return;
    }
    void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
  }, [remoteStream]);

  useEffect(() => {
    if (!activeCall?.startedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [activeCall?.startedAt]);

  const incoming = incomingCalls[0] ?? null;
  if (!activeCall && !incoming && !error) return null;

  const elapsed = activeCall?.startedAt
    ? Math.floor((now - new Date(activeCall.startedAt).getTime()) / 1000)
    : null;
  const stateLabel = activeCall
    ? activeCall.state === "connected" ? t("connected")
      : activeCall.state === "reconnecting" ? t("reconnecting")
      : activeCall.state === "failed" ? t("connectionFailed")
      : activeCall.state === "ending" ? t("ending")
      : t("connecting")
    : null;

  return (
    <section
      aria-live="polite"
      className="shrink-0 border-b border-primary/20 bg-card px-3 py-3 sm:px-4"
      data-testid="whatsapp-call-dock"
    >
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      {incoming && !activeCall && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
              <Phone className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{t("incomingCall")}</p>
              <p className="truncate text-xs text-muted-foreground">
                {incoming.customer_name || incoming.customer_phone || t("unknownContact")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onReject(incoming)}>
              <PhoneOff className="mr-1.5 h-3.5 w-3.5" />
              {t("reject")}
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => onAccept(incoming)}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Phone className="mr-1.5 h-3.5 w-3.5" />}
              {t("accept")}
            </Button>
          </div>
        </div>
      )}

      {activeCall && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
              <Phone className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{activeCall.contactName}</p>
              <p className="text-xs text-muted-foreground">
                {stateLabel}{elapsed !== null && activeCall.state === "connected" ? ` · ${formatDuration(elapsed)}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {audioBlocked && (
              <Button type="button" size="sm" variant="outline" onClick={() => {
                void audioRef.current?.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
              }}>
                <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                {t("enableAudio")}
              </Button>
            )}
            <Button type="button" size="icon-sm" variant="outline" disabled={busy} onClick={onToggleMute} aria-label={muted ? t("unmute") : t("mute")}>
              {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
            <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={onEnd}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <PhoneOff className="mr-1.5 h-3.5 w-3.5" />}
              {t("end")}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span>{error === "call_permission_required" ? t("permissionRequired") : error}</span>
          <button type="button" onClick={onClearError} aria-label={t("dismissError")} className="shrink-0">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </section>
  );
}
