"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeCallingPeerConnection,
  createAudioPeerConnection,
  readLocalSdp,
  stopCallingMediaStream,
  waitForIceGatheringComplete,
} from "@/lib/whatsapp/calling-webrtc";

export interface CallingCallRecord {
  id: string;
  phone_number_id: string;
  call_id: string;
  direction: "USER_INITIATED" | "BUSINESS_INITIATED" | null;
  contact_id: string | null;
  conversation_id: string | null;
  initiated_by_user_id: string | null;
  accepted_by_user_id: string | null;
  rejected_by_user_id: string | null;
  ended_by_user_id: string | null;
  customer_key: string | null;
  customer_phone: string | null;
  customer_name: string | null;
  state: string;
  claimed_by_user_id: string | null;
  claim_expires_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  created_at: string;
  claim_available?: boolean;
  claim_owned_by_me?: boolean;
  initiated_by_me?: boolean;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [];

export interface ActiveCallingSession {
  callId: string;
  conversationId: string;
  contactId: string;
  contactName: string;
  direction: "USER_INITIATED" | "BUSINESS_INITIATED";
  state: "connecting" | "ringing" | "connected" | "reconnecting" | "failed" | "ending";
  connectionState: RTCPeerConnectionState | RTCIceConnectionState | "new";
  startedAt: string | null;
}

interface CallApiPayload {
  calls?: CallingCallRecord[];
  call?: CallingCallRecord;
  session?: { sdp_type: "offer" | "answer"; sdp: string } | null;
  permission?: {
    status: "no_permission" | "temporary" | "permanent";
    expirationTime?: number;
    canStartCall: boolean;
    canRequestPermission: boolean;
  };
  call_id?: string;
  success?: boolean;
}

async function apiGet(path: string): Promise<CallApiPayload> {
  const response = await fetch(path, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
  }
  return payload as CallApiPayload;
}

async function apiPost(body: Record<string, unknown>): Promise<CallApiPayload> {
  const response = await fetch("/api/whatsapp/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
    const error = new Error(message) as Error & { code?: string; status?: number };
    error.code = typeof payload?.code === "string" ? payload.code : undefined;
    error.status = response.status;
    throw error;
  }
  return payload as CallApiPayload;
}

function currentPermission(permission: NonNullable<CallApiPayload["permission"]>): boolean {
  return permission.canStartCall && (
    permission.status === "permanent" ||
    (permission.status === "temporary" &&
      typeof permission.expirationTime === "number" &&
      permission.expirationTime * 1000 > Date.now())
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "WhatsApp Calling failed";
}

export function useWhatsAppCalling(iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS) {
  const [calls, setCalls] = useState<CallingCallRecord[]>([]);
  const [activeCall, setActiveCall] = useState<ActiveCallingSession | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const activeCallIdRef = useRef<string | null>(null);
  const activeCallRef = useRef<ActiveCallingSession | null>(null);
  const terminationRequestedRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  const cleanupMedia = useCallback(() => {
    stopCallingMediaStream(localStreamRef.current);
    localStreamRef.current = null;
    closeCallingPeerConnection(pcRef.current);
    pcRef.current = null;
    setRemoteStream(null);
    setMuted(false);
  }, []);

  const refreshCalls = useCallback(async () => {
    const payload = await apiGet("/api/whatsapp/calls");
    setCalls(Array.isArray(payload.calls) ? payload.calls : []);
  }, []);

  const incomingCalls = useMemo(
    () => calls.filter((call) =>
      call.direction === "USER_INITIATED" &&
      ["offered", "ringing"].includes(call.state) &&
      call.claim_available === true
    ),
    [calls],
  );

  const makePeerConnection = useCallback(() => {
    const pc = createAudioPeerConnection(iceServers, {
      onRemoteStream: (stream) => setRemoteStream(stream),
      onConnectionState: (connectionState) => {
        setActiveCall((current) => {
          if (!current) return current;
          if (connectionState === "connected" || connectionState === "completed") {
            return { ...current, state: "connected", connectionState };
          }
          if (connectionState === "disconnected") {
            return { ...current, state: "reconnecting", connectionState };
          }
          if (connectionState === "failed") {
            return { ...current, state: "failed", connectionState };
          }
          return { ...current, connectionState };
        });
      },
    });
    pcRef.current = pc;
    return pc;
  }, [iceServers]);

  const getLocalAudio = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Este navegador no permite acceder al micrófono.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    localStreamRef.current = stream;
    return stream;
  }, []);

  const startOutboundCall = useCallback(async (input: {
    contactId: string;
    conversationId: string;
    contactName: string;
  }): Promise<boolean> => {
    if (busyRef.current || activeCallIdRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      // Check consent before prompting for microphone access.
      const permissionPayload = await apiPost({
        action: "check_permission",
        contact_id: input.contactId,
      });
      if (!permissionPayload.permission || !currentPermission(permissionPayload.permission)) {
        setError("call_permission_required");
        return false;
      }

      const stream = await getLocalAudio();
      const pc = makePeerConnection();
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      const sdp = readLocalSdp(pc, "offer");

      const response = await apiPost({
        action: "connect",
        contact_id: input.contactId,
        conversation_id: input.conversationId,
        request_id: crypto.randomUUID(),
        session: { sdp_type: "offer", sdp },
      });
      if (!response.call_id) throw new Error("Meta no devolvió el identificador de llamada.");

      activeCallIdRef.current = response.call_id;
      terminationRequestedRef.current = false;
      setActiveCall({
        callId: response.call_id,
        conversationId: input.conversationId,
        contactId: input.contactId,
        contactName: input.contactName,
        direction: "BUSINESS_INITIATED",
        state: "connecting",
        connectionState: pc.connectionState,
        startedAt: null,
      });
      void refreshCalls().catch(() => undefined);
      return true;
    } catch (caught) {
      cleanupMedia();
      activeCallIdRef.current = null;
      setError(getErrorMessage(caught));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [cleanupMedia, getLocalAudio, makePeerConnection, refreshCalls]);

  const acceptIncomingCall = useCallback(async (call: CallingCallRecord): Promise<boolean> => {
    if (busyRef.current || activeCallIdRef.current) return false;
    if (!call.conversation_id || !call.contact_id) {
      setError("La llamada no tiene una conversación asociada.");
      return false;
    }
    let claimAcquired = false;
    let preAcceptSubmitted = false;
    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      await apiPost({ action: "claim", call_id: call.call_id });
      claimAcquired = true;
      const detail = await apiGet(`/api/whatsapp/calls?call_id=${encodeURIComponent(call.call_id)}`);
      if (detail.session?.sdp_type !== "offer" || !detail.session.sdp) {
        throw new Error("La oferta de audio de esta llamada ya no está disponible.");
      }

      // This function is called only by the explicit Accept button.
      const stream = await getLocalAudio();
      const pc = makePeerConnection();
      await pc.setRemoteDescription({ type: "offer", sdp: detail.session.sdp });
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGatheringComplete(pc);
      const sdp = readLocalSdp(pc, "answer");

      await apiPost({
        action: "pre_accept",
        call_id: call.call_id,
        conversation_id: call.conversation_id,
        session: { sdp_type: "answer", sdp },
      });
      preAcceptSubmitted = true;
      await apiPost({
        action: "accept",
        call_id: call.call_id,
        conversation_id: call.conversation_id,
      });

      activeCallIdRef.current = call.call_id;
      terminationRequestedRef.current = false;
      setActiveCall({
        callId: call.call_id,
        conversationId: call.conversation_id,
        contactId: call.contact_id,
        contactName: call.customer_name || call.customer_phone || "Contacto",
        direction: "USER_INITIATED",
        state: "ringing",
        connectionState: pc.connectionState,
        startedAt: call.started_at,
      });
      void refreshCalls().catch(() => undefined);
      return true;
    } catch (caught) {
      // Release only if setup failed before Meta received pre_accept. If
      // accept has an uncertain outcome, preserve the lease until it expires.
      if (claimAcquired && !preAcceptSubmitted) {
        await apiPost({ action: "release", call_id: call.call_id }).catch(() => undefined);
      }
      cleanupMedia();
      setError(getErrorMessage(caught));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [cleanupMedia, getLocalAudio, makePeerConnection, refreshCalls]);

  const rejectIncomingCall = useCallback(async (call: CallingCallRecord): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await apiPost({
        action: "reject",
        call_id: call.call_id,
        conversation_id: call.conversation_id,
      });
      await refreshCalls();
      return true;
    } catch (caught) {
      setError(getErrorMessage(caught));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [refreshCalls]);

  const endActiveCall = useCallback(async (): Promise<boolean> => {
    const callId = activeCallIdRef.current;
    const current = activeCall;
    if (!callId || !current || busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setActiveCall((previous) => previous ? { ...previous, state: "ending" } : previous);
    setError(null);
    try {
      await apiPost({
        action: "terminate",
        call_id: callId,
        conversation_id: current.conversationId,
      });
      activeCallIdRef.current = null;
      terminationRequestedRef.current = true;
      cleanupMedia();
      setActiveCall(null);
      await refreshCalls();
      return true;
    } catch (caught) {
      setError(getErrorMessage(caught));
      setActiveCall((previous) => previous ? { ...previous, state: "failed" } : previous);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [activeCall, cleanupMedia, refreshCalls]);

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    for (const track of localStreamRef.current?.getAudioTracks() ?? []) {
      track.enabled = !nextMuted;
    }
    setMuted(nextMuted);
  }, [muted]);

  // Keep the incoming-call lease alive while this agent owns the media
  // session. A renewal failure never starts a second call or steals ownership.
  useEffect(() => {
    if (!activeCall || activeCall.direction !== "USER_INITIATED") return;
    const renew = async () => {
      try {
        await apiPost({ action: "renew_claim", call_id: activeCall.callId });
      } catch {
        setError("No se pudo renovar la asignación de esta llamada.");
      }
    };
    const interval = window.setInterval(() => void renew(), 45_000);
    return () => window.clearInterval(interval);
  }, [activeCall?.callId, activeCall?.direction]);

    // Calls tables are intentionally service-role-only. Poll the authenticated
  // API instead of subscribing to the protected table from the browser.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const payload = await apiGet("/api/whatsapp/calls");
        if (!cancelled) setCalls(Array.isArray(payload.calls) ? payload.calls : []);
      } catch {
        // A transient polling error must not tear down an active media session.
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 3500);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Reconcile Meta's authoritative state and apply the remote answer for BIC.
  useEffect(() => {
    const callId = activeCall?.callId;
    if (!callId) return;
    let cancelled = false;
    const pollDetail = async () => {
      try {
        const detail = await apiGet(`/api/whatsapp/calls?call_id=${encodeURIComponent(callId)}`);
        if (cancelled || !detail.call) return;
        if (["terminated", "failed", "rejected"].includes(detail.call.state)) {
          activeCallIdRef.current = null;
          cleanupMedia();
          setActiveCall(null);
          void refreshCalls().catch(() => undefined);
          return;
        }
        const pc = pcRef.current;
        if (detail.session?.sdp_type === "answer" && pc && !pc.remoteDescription) {
          await pc.setRemoteDescription({ type: "answer", sdp: detail.session.sdp });
        }
        setActiveCall((current) => current && current.callId === callId
          ? {
              ...current,
              state: detail.call?.state === "connected" ? "connected" : current.state,
              startedAt: detail.call?.started_at ?? current.startedAt,
            }
          : current);
      } catch {
        // Keep the local peer connection alive while the API is temporarily unavailable.
      }
    };
    void pollDetail();
    const interval = window.setInterval(() => void pollDetail(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeCall?.callId, cleanupMedia, refreshCalls]);

  useEffect(() => {
    const terminateOnLeave = () => {
      const callId = activeCallIdRef.current;
      const current = activeCallRef.current;
      if (!callId || !current || terminationRequestedRef.current) return;
      terminationRequestedRef.current = true;
      void fetch("/api/whatsapp/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "terminate",
          call_id: callId,
          conversation_id: current.conversationId,
        }),
        keepalive: true,
      }).catch(() => undefined);
      activeCallIdRef.current = null;
      cleanupMedia();
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) terminateOnLeave();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      terminateOnLeave();
      activeCallIdRef.current = null;
      cleanupMedia();
    };
  }, [cleanupMedia]);

  return {
    calls,
    incomingCalls,
    activeCall,
    remoteStream,
    muted,
    busy,
    error,
    clearError: () => setError(null),
    refreshCalls,
    startOutboundCall,
    acceptIncomingCall,
    rejectIncomingCall,
    endActiveCall,
    toggleMute,
  };
}
