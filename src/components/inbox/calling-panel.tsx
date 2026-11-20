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
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Contact, Conversation } from "@/types";

type CallDirection = "USER_INITIATED" | "BUSINESS_INITIATED";
type CallSession = { sdp_type: "offer" | "answer"; sdp: string };
type CallSummary = {
  call_id: string;
  conversation_id: string | null;
  direction: CallDirection | null;
  state: string;
  customer_name: string | null;
  customer_phone: string | null;
  claim_available?: boolean;
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
    const cleanup = () => {
      window.clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
    };
    pc.addEventListener("icegatheringstatechange", onChange);
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
  // No static TURN credentials or third-party relay are embedded in the bundle.
  // ICE servers can be injected in a later, separately approved infrastructure increment.
  return new RTCPeerConnection({ iceServers: [] });
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
  const [uiState, setUiState] = useState<UiState>("idle");
  const [incomingCall, setIncomingCall] = useState<CallSummary | null>(null);
  const [activeCall, setActiveCall] = useState<CallSummary | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeCallRef = useRef<CallSummary | null>(null);
  const conversationIdRef = useRef<string | null>(conversation?.id ?? null);
  const mountedRef = useRef(true);
  const pollBusyRef = useRef(false);
  const connectedAtRef = useRef<number | null>(null);

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
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
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
    stopMedia();
    setCall(null);
    setIncomingCall(null);
    setUiState("idle");
    setErrorMessage(null);
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
    conversationIdRef.current = conversation?.id ?? null;
    setIncomingCall(null);
  }, [conversation?.id]);

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
    if (!conversation?.id || !contact?.id || uiState !== "idle") return;
    setUiState("requesting-media");
    setErrorMessage(null);
    try {
      const stream = await requestMicrophone();
      const peer = createPeerConnection();
      peerRef.current = peer;
      attachRemoteAudio(peer);
      addLocalAudio(peer, stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
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
      const answer = await waitForRemoteAnswer(callId);
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await waitForPeerConnected(peer);
      await enableAudio();
      setUiState("connected");
      setCall({ ...call, state: "connected" });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("callFailed");
      setErrorMessage(message);
      toast.error(message);
      const call = activeCallRef.current;
      if (call) {
        try {
          await postCallAction("terminate", { call_id: call.call_id });
        } catch {
          // Preserve the original failure; the server/webhook can reconcile termination.
        }
      }
      resetCall();
    }
  }, [addLocalAudio, attachRemoteAudio, contact, conversation, enableAudio, requestMicrophone, resetCall, setCall, t, uiState, waitForRemoteAnswer]);

  const acceptIncoming = useCallback(async () => {
    const incoming = incomingCall;
    if (!incoming || uiState !== "idle") return;
    setUiState("requesting-media");
    setErrorMessage(null);
    let claimed = false;
    try {
      const stream = await requestMicrophone();
      setUiState("claiming");
      await postCallAction("claim", { call_id: incoming.call_id });
      claimed = true;
      const detail = await getCallDetail(incoming.call_id);
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
      const localSdp = peer.localDescription?.sdp;
      if (!localSdp) throw new Error(t("localAnswerMissing"));

      setUiState("connecting");
      await postCallAction("pre_accept", {
        call_id: incoming.call_id,
        session: { sdp_type: "answer", sdp: localSdp },
        conversation_id: conversation?.id,
      });
      await waitForPeerConnected(peer);
      await postCallAction("accept", {
        call_id: incoming.call_id,
        conversation_id: conversation?.id,
      });
      await enableAudio();
      const acceptedCall = { ...incoming, state: "connected" };
      setCall(acceptedCall);
      setIncomingCall(null);
      setUiState("connected");
    } catch (error) {
      const message = error instanceof Error ? error.message : t("callFailed");
      setErrorMessage(message);
      toast.error(message);
      if (claimed) await releaseClaim(incoming.call_id);
      resetCall();
    }
  }, [addLocalAudio, attachRemoteAudio, conversation?.id, enableAudio, incomingCall, releaseClaim, requestMicrophone, resetCall, setCall, t, uiState]);

  const rejectIncoming = useCallback(async () => {
    if (!incomingCall) return;
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
      setUiState("incoming");
    }
  }, [conversation?.id, incomingCall, t]);

  const endCall = useCallback(async () => {
    const call = activeCallRef.current;
    if (!call) return;
    setUiState("ending");
    try {
      await postCallAction("terminate", { call_id: call.call_id });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("endCallFailed");
      toast.error(message);
    } finally {
      resetCall();
    }
  }, [resetCall, t]);

  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    if (tracks.length === 0) return;
    const nextMuted = !muted;
    tracks.forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }, [muted]);

  const hasCallingIdentity = Boolean(contact?.id && (contact.phone || contact.phone_optional));
  const busy = !["idle", "incoming", "connected", "failed"].includes(uiState);

  return (
    <div className="flex items-center gap-2">
      <audio ref={audioRef} autoPlay playsInline muted className="hidden" />
      {incomingCall && uiState === "idle" ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5">
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
      ) : uiState === "connected" && activeCall ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1.5">
          <span className="text-xs font-medium text-emerald-500">{formatDuration(elapsedSeconds)}</span>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? t("unmute") : t("mute")}
            title={muted ? t("unmute") : t("mute")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
          >
            {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => void endCall()}
            aria-label={t("endCall")}
            title={t("endCall")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-red-600 text-white hover:bg-red-700"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void startOutgoing()}
          disabled={!hasCallingIdentity || busy || !conversation || Boolean(contact?.blocked)}
          title={contact?.blocked ? t("contactBlocked") : t("startCall")}
          className={cn(
            "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Phone className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{busy ? t("connecting") : t("call")}</span>
        </button>
      )}
      {errorMessage && uiState === "idle" ? (
        <span role="status" className="max-w-40 truncate text-[11px] text-red-500">{errorMessage}</span>
      ) : null}
    </div>
  );
}
