"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LoaderCircle,
  Mic,
  MicOff,
  Phone,
  PhoneIncoming,
  PhoneOff,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Contact, Conversation } from "@/types";

type CallDirection = "USER_INITIATED" | "BUSINESS_INITIATED";
type CallSession = { sdp_type: "offer" | "answer"; sdp: string };
type CallPermission = {
  status: "no_permission" | "temporary" | "permanent";
  expirationTime?: number;
  canStartCall: boolean;
  canRequestPermission: boolean;
};
type CallSummary = {
  call_id: string;
  conversation_id: string | null;
  direction: CallDirection | null;
  state: string;
  customer_name: string | null;
  customer_phone: string | null;
  claim_available?: boolean;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  duration_seconds?: number | null;
};
type CallDetail = {
  call: CallSummary & { claimed_by_user_id?: string | null };
  session: CallSession | null;
};

type UiState =
  | "idle"
  | "requesting-media"
  | "claiming"
  | "connecting"
  | "incoming"
  | "connected"
  | "ending"
  | "failed";

const ICE_GATHERING_TIMEOUT_MS = 12_000;
const SIGNALING_TIMEOUT_MS = 30_000;
const INCOMING_POLL_MS = 2_500;

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : "Calling request failed";
    throw new Error(message);
  }
  return data as Record<string, unknown>;
}

async function postCallAction(action: string, values: Record<string, unknown> = {}) {
  const response = await fetch("/api/whatsapp/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ action, ...values }),
  });
  return readJson(response);
}

async function getCallDetail(callId: string): Promise<CallDetail> {
  const response = await fetch(
    `/api/whatsapp/calls?call_id=${encodeURIComponent(callId)}`,
    { cache: "no-store", credentials: "same-origin" },
  );
  const data = await readJson(response);
  return data as unknown as CallDetail;
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("ICE gathering timed out. Check network connectivity."));
    }, ICE_GATHERING_TIMEOUT_MS);
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    const onConnectionChange = () => {
      if (pc.connectionState === "closed" || pc.connectionState === "failed") {
        cleanup();
        reject(new Error("WebRTC peer connection was closed before ICE gathering completed."));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      pc.removeEventListener("connectionstatechange", onConnectionChange);
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    pc.addEventListener("connectionstatechange", onConnectionChange);
  });
}

function waitForPeerConnected(pc: RTCPeerConnection): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("WebRTC connection timed out. The network may require TURN."));
    }, SIGNALING_TIMEOUT_MS);
    const onChange = () => {
      if (pc.connectionState === "connected") {
        cleanup();
        resolve();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanup();
        reject(new Error("WebRTC could not establish the audio connection."));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", onChange);
    };
    pc.addEventListener("connectionstatechange", onChange);
  });
}

function createPeerConnection(): RTCPeerConnection {
  // Optional STUN-only configuration is public by design; never put TURN
  // usernames/passwords or provider secrets in NEXT_PUBLIC variables.
  const stunUrls = (process.env.NEXT_PUBLIC_WHATSAPP_CALLING_STUN_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("stun:"));
  return new RTCPeerConnection({
    iceServers: stunUrls.length > 0 ? [{ urls: stunUrls }] : [],
  });
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

interface CallingPanelProps {
  conversation: Conversation | null;
  contact: Contact | null;
}

export function CallingPanel({ conversation, contact }: CallingPanelProps) {
  const t = useTranslations("Inbox.calling");
  const { profile } = useAuth();
  const [uiState, setUiState] = useState<UiState>("idle");
  const [incomingCall, setIncomingCall] = useState<CallSummary | null>(null);
  const [activeCall, setActiveCall] = useState<CallSummary | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [permission, setPermission] = useState<CallPermission | null>(null);
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [permissionRequesting, setPermissionRequesting] = useState(false);
  const [permissionRequestSent, setPermissionRequestSent] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [recentCalls, setRecentCalls] = useState<CallSummary[]>([]);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeCallRef = useRef<CallSummary | null>(null);
  const conversationIdRef = useRef<string | null>(conversation?.id ?? null);
  const mountedRef = useRef(true);
  const pollBusyRef = useRef(false);
  const operationRef = useRef(false);
  const tearingDownRef = useRef(false);
  const connectedAtRef = useRef<number | null>(null);
  const disconnectTimerRef = useRef<number | null>(null);

  const isPilotContact = Boolean(contact?.phone && contact.phone.replace(/[^0-9]/g, "") === "51980942247");

  const refreshPermission = useCallback(async () => {
    if (!contact?.id || !isPilotContact) {
      setPermission(null);
      setPermissionError(null);
      setPermissionRequestSent(false);
      return;
    }
    setPermissionLoading(true);
    try {
      const data = await postCallAction("check_permission", { contact_id: contact.id });
      setPermission(data.permission as CallPermission);
      setPermissionError(null);
    } catch (error) {
      setPermission(null);
      setPermissionError(error instanceof Error ? error.message : t("permissionCheckFailed"));
    } finally {
      setPermissionLoading(false);
    }
  }, [contact?.id, isPilotContact, t]);

  const setCall = useCallback((call: CallSummary | null) => {
    activeCallRef.current = call;
    setActiveCall(call);
  }, []);

  const stopMedia = useCallback(() => {
    const peer = peerRef.current;
    peerRef.current = null;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;
    if (disconnectTimerRef.current !== null) {
      window.clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
      audioRef.current.muted = true;
    }
    connectedAtRef.current = null;
    setMuted(false);
    setElapsedSeconds(0);
  }, []);

  const attachRemoteAudio = useCallback((peer: RTCPeerConnection) => {
    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      remoteStreamRef.current = stream;
      if (audioRef.current) {
        audioRef.current.srcObject = stream;
        audioRef.current.muted = true;
      }
    };
  }, [t]);

  const enableAudio = useCallback(async () => {
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    if (audioRef.current) {
      audioRef.current.muted = false;
      try {
        await audioRef.current.play();
      } catch {
        setErrorMessage(t("tapToHear"));
      }
    }
  }, [t]);

  const requestMicrophone = useCallback(async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(t("secureContextRequired"));
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    stream.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    localStreamRef.current = stream;
    return stream;
  }, [t]);

  const addLocalAudio = useCallback((peer: RTCPeerConnection, stream: MediaStream) => {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error(t("microphoneTrackMissing"));
    peer.addTrack(track, stream);
  }, [t]);

  const waitForRemoteAnswer = useCallback(async (callId: string) => {
    const deadline = Date.now() + SIGNALING_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const detail = await getCallDetail(callId);
      if (detail.session?.sdp_type === "answer" && detail.session.sdp) return detail.session;
      if (["failed", "terminated", "rejected"].includes(detail.call.state)) {
        throw new Error(t("callEndedBeforeAnswer"));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 900));
    }
    throw new Error(t("remoteAnswerTimedOut"));
  }, [t]);

  const releaseClaim = useCallback(async (callId: string) => {
    try {
      await postCallAction("release", { call_id: callId });
    } catch {
      // A terminal webhook may already have released the lease.
    }
  }, []);

  const resetCall = useCallback(() => {
    tearingDownRef.current = true;
    stopMedia();
    setCall(null);
    setIncomingCall(null);
    setUiState("idle");
    setErrorMessage(null);
    tearingDownRef.current = false;
  }, [setCall, stopMedia]);

  const pollIncoming = useCallback(async () => {
    if (!conversation?.id || pollBusyRef.current || activeCallRef.current || uiState !== "idle") return;
    pollBusyRef.current = true;
    try {
      const response = await fetch("/api/whatsapp/calls", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const data = await readJson(response);
      const calls = Array.isArray(data.calls) ? data.calls as CallSummary[] : [];
      if (mountedRef.current) {
        setRecentCalls(calls.filter((call) => call.conversation_id === conversation.id));
      }
      const incoming = calls.find((call) =>
        call.conversation_id === conversation.id
        && call.direction === "USER_INITIATED"
        && ["offered", "ringing"].includes(call.state)
        && call.claim_available !== false
      );
      if (mountedRef.current) setIncomingCall(incoming ?? null);
    } catch {
      // Poll failures are transient; do not interrupt message handling.
    } finally {
      pollBusyRef.current = false;
    }
  }, [conversation?.id, uiState]);

  useEffect(() => {
    void refreshPermission();
  }, [refreshPermission, conversation?.id]);

  useEffect(() => {
    const nextConversationId = conversation?.id ?? null;
    const previousConversationId = conversationIdRef.current;
    conversationIdRef.current = nextConversationId;
    setIncomingCall(null);
    const active = activeCallRef.current;
    if (previousConversationId && previousConversationId !== nextConversationId) {
      if (active && !operationRef.current) {
        operationRef.current = true;
        setUiState("ending");
        void postCallAction("terminate", { call_id: active.call_id })
          .then(() => {
            if (activeCallRef.current?.call_id === active.call_id) resetCall();
          })
          .catch((error) => {
            if (activeCallRef.current?.call_id !== active.call_id) return;
            // Preserve retry controls on the new thread, but never leave the
            // previous conversation's microphone or remote audio attached.
            stopMedia();
            setUiState("failed");
            setErrorMessage(error instanceof Error ? error.message : t("endCallFailed"));
          })
          .finally(() => {
            operationRef.current = false;
          });
      } else if (!active && operationRef.current) {
        stopMedia();
        setUiState("idle");
      }
    }
  }, [conversation?.id, resetCall, stopMedia, t]);

  useEffect(() => {
    mountedRef.current = true;
    void pollIncoming();
    const timer = window.setInterval(() => void pollIncoming(), INCOMING_POLL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [pollIncoming]);

  useEffect(() => {
    if (uiState !== "connected") return;
    connectedAtRef.current ??= Date.now();
    const timer = window.setInterval(() => {
      if (connectedAtRef.current) {
        setElapsedSeconds(Math.floor((Date.now() - connectedAtRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [uiState]);

  useEffect(() => {
    return () => {
      const call = activeCallRef.current;
      if (call) {
        void postCallAction("terminate", { call_id: call.call_id });
      }
      stopMedia();
    };
  }, [stopMedia]);

  const startOutgoing = useCallback(async () => {
    if (!conversation?.id || !contact?.id || uiState !== "idle"
      || operationRef.current || !permission?.canStartCall || !isPilotContact) return;
    operationRef.current = true;
    const operationConversationId = conversation.id;
    setUiState("requesting-media");
    setErrorMessage(null);
    try {
      const stream = await requestMicrophone();
      if (conversationIdRef.current !== operationConversationId) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(t("conversationChanged"));
      }
      const peer = createPeerConnection();
      peerRef.current = peer;
      attachRemoteAudio(peer);
      addLocalAudio(peer, stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      const localSdp = peer.localDescription?.sdp;
      if (!localSdp) throw new Error(t("localOfferMissing"));

      setUiState("connecting");
      const requestId = crypto.randomUUID();
      const result = await postCallAction("connect", {
        contact_id: contact.id,
        conversation_id: conversation.id,
        request_id: requestId,
        session: { sdp_type: "offer", sdp: localSdp },
      });
      const callId = typeof result.call_id === "string" ? result.call_id : "";
      if (!callId) throw new Error(t("callIdMissing"));
      const call: CallSummary = {
        call_id: callId,
        conversation_id: conversation.id,
        direction: "BUSINESS_INITIATED",
        state: "connecting",
        customer_name: contact.name ?? null,
        customer_phone: contact.phone ?? null,
      };
      setCall(call);
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      const answer = await waitForRemoteAnswer(callId);
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await waitForPeerConnected(peer);
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      await enableAudio();
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      setUiState("connected");
      setCall({ ...call, state: "connected" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("callFailed");
      toast.error(message);
      const call = activeCallRef.current;
      let terminationError: string | null = null;
      if (call) {
        try {
          await postCallAction("terminate", { call_id: call.call_id });
        } catch (terminateError) {
          terminationError = terminateError instanceof Error ? terminateError.message : t("endCallFailed");
        }
      }
      if (call && terminationError) {
        // Do not hide a server-side call whose termination could not be confirmed.
        // Stop local media for privacy, but preserve the call ID and retry control.
        stopMedia();
        setUiState("failed");
        setErrorMessage(`${message} · ${terminationError}`);
      } else {
        resetCall();
        setErrorMessage(message);
      }
    } finally {
      operationRef.current = false;
    }
  }, [addLocalAudio, attachRemoteAudio, contact, conversation, enableAudio, isPilotContact, permission?.canStartCall, requestMicrophone, resetCall, setCall, stopMedia, t, uiState, waitForRemoteAnswer]);

  const acceptIncoming = useCallback(async () => {
    const incoming = incomingCall;
    if (!incoming || uiState !== "idle" || operationRef.current) return;
    operationRef.current = true;
    const operationConversationId = conversation?.id ?? null;
    setUiState("requesting-media");
    setErrorMessage(null);
    let claimed = false;
    let preAcceptAttempted = false;
    try {
      const stream = await requestMicrophone();
      if (conversationIdRef.current !== operationConversationId) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error(t("conversationChanged"));
      }
      setUiState("claiming");
      await postCallAction("claim", { call_id: incoming.call_id });
      claimed = true;
      if (conversationIdRef.current !== operationConversationId) {
        await releaseClaim(incoming.call_id);
        claimed = false;
        throw new Error(t("conversationChanged"));
      }
      const detail = await getCallDetail(incoming.call_id);
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      if (detail.session?.sdp_type !== "offer" || !detail.session.sdp) {
        throw new Error(t("incomingOfferMissing"));
      }
      const peer = createPeerConnection();
      peerRef.current = peer;
      attachRemoteAudio(peer);
      addLocalAudio(peer, stream);
      await peer.setRemoteDescription({ type: "offer", sdp: detail.session.sdp });
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIceGathering(peer);
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      const localSdp = peer.localDescription?.sdp;
      if (!localSdp) throw new Error(t("localAnswerMissing"));

      setUiState("connecting");
      preAcceptAttempted = true;
      await postCallAction("pre_accept", {
        call_id: incoming.call_id,
        session: { sdp_type: "answer", sdp: localSdp },
        conversation_id: conversation?.id,
      });
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      await waitForPeerConnected(peer);
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      const accepted = await postCallAction("accept", {
        call_id: incoming.call_id,
        conversation_id: conversation?.id,
      });
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      if (accepted.agent_attribution_recorded !== true && accepted.already_accepted !== true) {
        throw new Error(t("callAcceptanceNotRecorded"));
      }
      await enableAudio();
      if (conversationIdRef.current !== operationConversationId) throw new Error(t("conversationChanged"));
      const acceptedCall = { ...incoming, state: "connected" };
      setCall(acceptedCall);
      setIncomingCall(null);
      setUiState("connected");
    } catch (error) {
      const message = error instanceof Error ? error.message : t("callFailed");
      toast.error(message);
      let terminationError: string | null = null;
      if (preAcceptAttempted) {
        try {
          await postCallAction("terminate", { call_id: incoming.call_id });
        } catch (terminateError) {
          terminationError = terminateError instanceof Error ? terminateError.message : t("endCallFailed");
        }
      } else if (claimed) {
        await releaseClaim(incoming.call_id);
      }
      if (preAcceptAttempted && terminationError) {
        // Keep the call visible for a retry, while releasing all local media.
        stopMedia();
        setCall({ ...incoming, state: "failed" });
        setIncomingCall(null);
        setUiState("failed");
        setErrorMessage(`${message} · ${terminationError}`);
      } else {
        resetCall();
        setErrorMessage(message);
      }
    } finally {
      operationRef.current = false;
    }
  }, [addLocalAudio, attachRemoteAudio, conversation?.id, enableAudio, incomingCall, releaseClaim, requestMicrophone, resetCall, setCall, stopMedia, t, uiState]);

  const rejectIncoming = useCallback(async () => {
    if (!incomingCall || operationRef.current) return;
    operationRef.current = true;
    setUiState("ending");
    try {
      await postCallAction("reject", {
        call_id: incomingCall.call_id,
        conversation_id: conversation?.id,
      });
      setIncomingCall(null);
      setUiState("idle");
    } catch (error) {
      const message = error instanceof Error ? error.message : t("rejectFailed");
      setErrorMessage(message);
      toast.error(message);
      setUiState("idle");
    } finally {
      operationRef.current = false;
    }
  }, [conversation?.id, incomingCall, t]);

  const endCall = useCallback(async () => {
    const call = activeCallRef.current;
    if (!call || operationRef.current) return;
    operationRef.current = true;
    setUiState("ending");
    setErrorMessage(null);
    try {
      await postCallAction("terminate", { call_id: call.call_id });
      resetCall();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("endCallFailed");
      // Keep the active call and its controls available so the agent can retry.
      setErrorMessage(message);
      setUiState("failed");
      toast.error(message);
    } finally {
      operationRef.current = false;
    }
  }, [resetCall, t]);

  const requestPermission = useCallback(async () => {
    if (!contact?.id || operationRef.current || permissionRequesting
      || !permission?.canRequestPermission || !isPilotContact) return;
    operationRef.current = true;
    setPermissionRequesting(true);
    setPermissionError(null);
    try {
      await postCallAction("request_permission", { contact_id: contact.id });
      setPermissionRequestSent(true);
      await refreshPermission();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("permissionRequestFailed");
      setPermissionError(message);
      toast.error(message);
    } finally {
      setPermissionRequesting(false);
      operationRef.current = false;
    }
  }, [contact?.id, isPilotContact, permission?.canRequestPermission, permissionRequesting, refreshPermission, t]);

  useEffect(() => {
    if (uiState !== "connected") return;
    const peer = peerRef.current;
    if (!peer) return;

    const onConnectionStateChange = () => {
      if (tearingDownRef.current || peerRef.current !== peer) return;
      if (peer.connectionState === "connected") {
        if (disconnectTimerRef.current !== null) {
          window.clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }
        return;
      }
      if (peer.connectionState === "disconnected") {
        if (disconnectTimerRef.current === null) {
          disconnectTimerRef.current = window.setTimeout(() => {
            disconnectTimerRef.current = null;
            if (peerRef.current === peer && peer.connectionState === "disconnected") {
              void endCall();
            }
          }, 8_000);
        }
        return;
      }
      if (peer.connectionState === "failed" || peer.connectionState === "closed") {
        void endCall();
      }
    };

    peer.addEventListener("connectionstatechange", onConnectionStateChange);
    return () => {
      peer.removeEventListener("connectionstatechange", onConnectionStateChange);
      if (disconnectTimerRef.current !== null) {
        window.clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
    };
  }, [endCall, uiState]);

  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    if (tracks.length === 0) return;
    const nextMuted = !muted;
    tracks.forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }, [muted]);

  const isPilotActiveCall = Boolean(
    activeCall?.customer_phone
    && activeCall.customer_phone.replace(/[^0-9]/g, "") === "51980942247",
  );
  const hasCallingIdentity = Boolean(contact?.id && contact.phone && isPilotContact && permission?.canStartCall);
  const busy = !["idle", "incoming", "connected", "failed"].includes(uiState);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <audio ref={audioRef} autoPlay playsInline muted className="hidden" />
      {isPilotContact && incomingCall && uiState === "idle" ? (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5">
          <PhoneIncoming className="h-4 w-4 text-emerald-500" />
          <span className="max-w-32 truncate text-xs font-medium">
            {incomingCall.customer_name || contact?.name || t("incomingCall")}
          </span>
          <button
            type="button"
            onClick={() => void acceptIncoming()}
            className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700"
          >
            {t("accept")}
          </button>
          <button
            type="button"
            onClick={() => void rejectIncoming()}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {t("reject")}
          </button>
        </div>
      ) : null}
      {(isPilotContact || isPilotActiveCall) && ["connected", "failed"].includes(uiState) && activeCall ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5">
          <span className={cn("text-xs font-medium", uiState === "connected" ? "text-emerald-500" : "text-red-500")}>
            {uiState === "connected" ? formatDuration(elapsedSeconds) : t("endCallFailed")}
          </span>
          <span className="max-w-28 truncate text-[11px] text-muted-foreground" title={profile?.full_name ?? t("agent")}>
            {profile?.full_name ?? t("agent")}
          </span>
          {["connected", "failed"].includes(uiState) ? (
            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? t("unmute") : t("mute")}
              title={muted ? t("unmute") : t("mute")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
            >
              {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void endCall()}
            aria-label={t("endCall")}
            title={t("endCall")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-red-600 text-white hover:bg-red-700"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
          {uiState === "failed" && errorMessage ? (
            <span role="status" className="max-w-40 truncate text-[11px] text-red-500">{errorMessage}</span>
          ) : null}
        </div>
      ) : null}
      {isPilotContact && !incomingCall && !["connected", "failed"].includes(uiState) && permission?.canStartCall ? (
        <button
          type="button"
          onClick={() => void startOutgoing()}
          disabled={!hasCallingIdentity || busy || permissionLoading || !conversation || Boolean(contact?.blocked)}
          title={contact?.blocked ? t("contactBlocked") : t("startCall")}
          className={cn(
            "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Phone className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{busy ? t("connecting") : t("call")}</span>
        </button>
      ) : null}
      {uiState === "idle" && isPilotContact && permission?.status === "no_permission" ? (
        <div className="flex items-center gap-1">
          <span className="hidden text-[11px] text-amber-600 sm:inline">{t("permissionNeeded")}</span>
          {permission.canRequestPermission ? (
            <button
              type="button"
              onClick={() => void requestPermission()}
              disabled={permissionLoading || permissionRequesting}
              className="rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted disabled:opacity-50"
            >
              {permissionRequesting ? t("sendingPermissionRequest") : permissionRequestSent ? t("permissionRequestSent") : t("requestPermission")}
            </button>
          ) : (
            <span className="text-[11px] text-muted-foreground">{t("permissionRequestUnavailable")}</span>
          )}
        </div>
      ) : null}
      {uiState === "idle" && isPilotContact && permission?.canStartCall ? (
        <span className="hidden text-[11px] text-emerald-600 sm:inline">{t("permissionActive")}</span>
      ) : null}
      {permissionError && uiState === "idle" && isPilotContact ? (
        <span role="status" className="max-w-40 truncate text-[11px] text-red-500">{permissionError}</span>
      ) : null}
      {recentCalls.length > 0 && uiState === "idle" ? (
        <details className="max-w-52 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t("history")} ({recentCalls.length})</summary>
          <ul className="mt-1 max-h-36 space-y-1 overflow-y-auto rounded-md border border-border bg-card p-2">
            {recentCalls.slice(0, 8).map((call) => (
              <li key={call.call_id} className="flex items-center justify-between gap-2">
                <span className="truncate">{call.direction === "USER_INITIATED" ? t("incoming") : t("outgoing")}</span>
                <span className="shrink-0 text-muted-foreground">{call.state.replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {errorMessage && uiState === "idle" ? (
        <span role="status" className="max-w-40 truncate text-[11px] text-red-500">{errorMessage}</span>
      ) : null}
    </div>
  );
}
