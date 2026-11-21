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
import { useCan } from "@/hooks/use-can";
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
  initiated_by_name?: string | null;
  accepted_by_name?: string | null;
  rejected_by_name?: string | null;
  ended_by_name?: string | null;
  claim_available?: boolean;
  created_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  duration_seconds?: number | null;
};
type CallDetail = {
  call: CallSummary & {
    claimed_by_user_id?: string | null;
    claim_expires_at?: string | null;
    session_sdp_expires_at?: string | null;
  };
  session: CallSession | null;
  claim_owned_by_me?: boolean;
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

// CALL-03B2.4 — claim-before-microphone. The server lease (whatsapp_call_claim)
// is 90 seconds and the inbound offer SDP lives 60 seconds from the webhook.
const CLAIM_LEASE_MS = 90_000;
const CLAIM_HEARTBEAT_MS = 30_000;
const MIC_TIMEOUT_MAX_MS = 30_000;
const OFFER_SAFETY_MARGIN_MS = 15_000;
// Below this window a permission dialog cannot realistically be answered.
const MIN_MIC_WINDOW_MS = 5_000;
const RENEW_RETRIES = 1;
/** Exposed so tests can pin the timing contract to the server limits. */
export const CALLING_ACCEPT_LIMITS = {
  claimLeaseMs: CLAIM_LEASE_MS,
  heartbeatMs: CLAIM_HEARTBEAT_MS,
  micTimeoutMaxMs: MIC_TIMEOUT_MAX_MS,
  offerSafetyMarginMs: OFFER_SAFETY_MARGIN_MS,
  minMicWindowMs: MIN_MIC_WINDOW_MS,
} as const;

/**
 * Browser services used by one panel instance. Defaults to the real globals;
 * tests inject per-panel instrumentation so two panels can be told apart.
 */
export interface CallingPanelRuntime {
  fetch: typeof fetch;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection: () => RTCPeerConnection;
}

function resolveRuntime(override?: Partial<CallingPanelRuntime>) {
  const fetchImpl: typeof fetch = override?.fetch ?? ((input, init) => fetch(input, init));
  return {
    fetch: fetchImpl,
    post: (action: string, values: Record<string, unknown> = {}) => postCallAction(action, values, fetchImpl),
    detail: (callId: string) => getCallDetail(callId, fetchImpl),
    hasMicrophoneApi: () => Boolean(override?.getUserMedia ?? navigator.mediaDevices?.getUserMedia),
    getUserMedia: (constraints: MediaStreamConstraints) => (
      override?.getUserMedia
        ? override.getUserMedia(constraints)
        : navigator.mediaDevices.getUserMedia(constraints)
    ),
    createPeerConnection: override?.createPeerConnection ?? (() => createPeerConnection()),
  };
}

type AcceptAbortReason = "conversation-changed" | "unmount" | "claim-lost";
type AcceptStepCode = "offer-expiring" | "mic-timeout" | "claim-lost";

/** HTTP failure from /api/whatsapp/calls. `status` is null for network errors. */
class CallApiError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "CallApiError";
  }
}

class AcceptAborted extends Error {
  constructor(readonly reason: AcceptAbortReason) {
    super(`accept_aborted:${reason}`);
    this.name = "AcceptAborted";
  }
}

class AcceptStepError extends Error {
  constructor(readonly code: AcceptStepCode) {
    super(`accept_step:${code}`);
    this.name = "AcceptStepError";
  }
}

/** The server answered and refused: the claim is not (or no longer) ours. */
function isClaimRejection(error: unknown): boolean {
  return error instanceof CallApiError
    && error.status !== null
    && [403, 404, 409].includes(error.status);
}

/** The request definitely did not acquire a claim (as opposed to "unknown"). */
function isDefiniteClaimFailure(error: unknown): boolean {
  return error instanceof CallApiError
    && error.status !== null
    && error.status >= 400
    && error.status < 500;
}

function isMicrophoneDenied(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError";
}

function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

/** One in-flight "accept incoming call" attempt. Single owner of the claim. */
type AcceptOperation = {
  callId: string;
  conversationId: string | null;
  aborted: boolean;
  abortReason: AcceptAbortReason | null;
  claimed: boolean;
  claimLost: boolean;
  released: boolean;
  preAccept: boolean;
  terminateSent: boolean;
  terminationError: string | null;
  finished: boolean;
  renewing: boolean;
  lastRenewAt: number;
  heartbeat: number | null;
  abortSignal: Promise<never>;
  rejectAbort: (error: AcceptAborted) => void;
  finalizeChain: Promise<void>;
};

function createAcceptOperation(callId: string, conversationId: string | null): AcceptOperation {
  let rejectAbort: (error: AcceptAborted) => void = () => {};
  const abortSignal = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // The signal is raced by many awaits; never surface it as unhandled.
  abortSignal.catch(() => {});
  return {
    callId,
    conversationId,
    aborted: false,
    abortReason: null,
    claimed: false,
    claimLost: false,
    released: false,
    preAccept: false,
    terminateSent: false,
    terminationError: null,
    finished: false,
    renewing: false,
    lastRenewAt: 0,
    heartbeat: null,
    abortSignal,
    rejectAbort,
    finalizeChain: Promise.resolve(),
  };
}

function abortable<T>(op: AcceptOperation, promise: Promise<T>): Promise<T> {
  return Promise.race([promise, op.abortSignal]) as Promise<T>;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : "Calling request failed";
    throw new CallApiError(message, response.status);
  }
  return data as Record<string, unknown>;
}

async function postCallAction(
  action: string,
  values: Record<string, unknown> = {},
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
) {
  const response = await fetchImpl("/api/whatsapp/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ action, ...values }),
  });
  return readJson(response);
}

async function getCallDetail(
  callId: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<CallDetail> {
  const response = await fetchImpl(
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

function formatCallDate(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

interface CallingPanelProps {
  conversation: Conversation | null;
  contact: Contact | null;
  /** Test seam: per-panel fetch / microphone / PeerConnection. Defaults to the browser globals. */
  runtime?: Partial<CallingPanelRuntime>;
}

export function CallingPanel({ conversation, contact, runtime: runtimeOverride }: CallingPanelProps) {
  const t = useTranslations("Inbox.calling");
  const [runtime] = useState(() => resolveRuntime(runtimeOverride));
  const { profile } = useAuth();
  const canUseCalling = useCan("send-messages");
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
  const acceptOpRef = useRef<AcceptOperation | null>(null);
  const abortAcceptRef = useRef<(reason: AcceptAbortReason) => void>(() => {});
  const unmountedRef = useRef(false);
  const tearingDownRef = useRef(false);
  const connectedAtRef = useRef<number | null>(null);
  const disconnectTimerRef = useRef<number | null>(null);

  const isPilotContact = Boolean(contact?.phone && contact.phone.replace(/[^0-9]/g, "") === "51980942247");

  const refreshPermission = useCallback(async () => {
    if (!canUseCalling || !contact?.id || !isPilotContact) {
      setPermission(null);
      setPermissionError(null);
      setPermissionRequestSent(false);
      return;
    }
    setPermissionLoading(true);
    try {
      const data = await runtime.post("check_permission", { contact_id: contact.id });
      setPermission(data.permission as CallPermission);
      setPermissionError(null);
    } catch (error) {
      setPermission(null);
      setPermissionError(error instanceof Error ? error.message : t("permissionCheckFailed"));
    } finally {
      setPermissionLoading(false);
    }
  }, [runtime, canUseCalling, contact?.id, isPilotContact, t]);

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
    if (!unmountedRef.current) {
      setMuted(false);
      setElapsedSeconds(0);
    }
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
  }, []);

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
    if (!window.isSecureContext || !runtime.hasMicrophoneApi()) {
      throw new Error(t("secureContextRequired"));
    }
    const stream = await runtime.getUserMedia({
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
  }, [runtime, t]);

  const addLocalAudio = useCallback((peer: RTCPeerConnection, stream: MediaStream) => {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error(t("microphoneTrackMissing"));
    peer.addTrack(track, stream);
  }, [t]);

  const waitForRemoteAnswer = useCallback(async (callId: string) => {
    const deadline = Date.now() + SIGNALING_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const detail = await runtime.detail(callId);
      if (detail.session?.sdp_type === "answer" && detail.session.sdp) return detail.session;
      if (["failed", "terminated", "rejected"].includes(detail.call.state)) {
        throw new Error(t("callEndedBeforeAnswer"));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 900));
    }
    throw new Error(t("remoteAnswerTimedOut"));
  }, [runtime, t]);

  const releaseClaim = useCallback(async (callId: string) => {
    try {
      await runtime.post("release", { call_id: callId });
    } catch {
      // A terminal webhook may already have released the lease.
    }
  }, [runtime, ]);

  const stopHeartbeat = useCallback((op: AcceptOperation) => {
    if (op.heartbeat !== null) {
      window.clearInterval(op.heartbeat);
      op.heartbeat = null;
    }
  }, []);

  /**
   * Confirm current claim ownership before any cleanup action. A recently
   * renewed lease is not proof of ownership: an admin may release it and a
   * different agent may claim the call before its original expiry.
   * This GET is defensive, not atomic with the subsequent POST.
   */
  const inspectLeaseOwner = useCallback(async (op: AcceptOperation): Promise<"mine" | "free" | "other" | "unknown"> => {
    try {
      const detail = await runtime.detail(op.callId);
      if (detail.claim_owned_by_me === true) return "mine";
      const expiresAt = Date.parse(detail.call.claim_expires_at ?? "");
      const heldByAnother = Boolean(detail.call.claimed_by_user_id)
        && Number.isFinite(expiresAt)
        && expiresAt > Date.now();
      return heldByAnother ? "other" : "free";
    } catch {
      return "unknown";
    }
  }, [runtime]);

  /**
   * Releases whatever this attempt still owns, exactly once per resource and
   * serialised so a late claim response cannot skip its release.
   * - claim lost / owned by someone else: never touch the call;
   * - after pre_accept: close the call safely with terminate;
   * - otherwise: release the lease only (no terminate).
   */
  const finalizeAcceptClaim = useCallback((op: AcceptOperation): Promise<void> => {
    op.finalizeChain = op.finalizeChain.then(async () => {
      if (op.claimLost) return;
      if (op.preAccept) {
        if (op.terminateSent) return;
        const owner = await inspectLeaseOwner(op);
        // After pre_accept, a missing/free lease is not authority to end
        // the call. Let server-side SDP expiry clean it up if no owner exists.
        if (owner !== "mine") {
          op.claimLost = true;
          return;
        }
        op.terminateSent = true;
        try {
          await runtime.post("terminate", { call_id: op.callId });
        } catch (terminateError) {
          op.terminationError = terminateError instanceof Error ? terminateError.message : t("endCallFailed");
        }
        return;
      }
      if (op.claimed && !op.released) {
        op.released = true;
        // Only a lease that is provably ours is released; an expired one that
        // someone else now holds must stay untouched.
        if ((await inspectLeaseOwner(op)) === "mine") await releaseClaim(op.callId);
      }
    });
    return op.finalizeChain;
  }, [inspectLeaseOwner, releaseClaim, runtime, t]);

  /** Central abort: conversation switch, unmount and lost claim all land here. */
  const abortAccept = useCallback((reason: AcceptAbortReason) => {
    const op = acceptOpRef.current;
    if (!op || op.aborted || op.finished) return;
    op.aborted = true;
    op.abortReason = reason;
    if (reason === "claim-lost") op.claimLost = true;
    stopHeartbeat(op);
    op.rejectAbort(new AcceptAborted(reason));
    stopMedia();
    void finalizeAcceptClaim(op);
  }, [finalizeAcceptClaim, stopHeartbeat, stopMedia]);

  useEffect(() => {
    abortAcceptRef.current = abortAccept;
  }, [abortAccept]);

  const assertAcceptActive = useCallback((op: AcceptOperation) => {
    if (op.aborted) throw new AcceptAborted(op.abortReason ?? "claim-lost");
    if (conversationIdRef.current !== op.conversationId) {
      abortAccept("conversation-changed");
      throw new AcceptAborted("conversation-changed");
    }
  }, [abortAccept]);

  const startHeartbeat = useCallback((op: AcceptOperation) => {
    stopHeartbeat(op);
    op.heartbeat = window.setInterval(() => {
      if (op.aborted || op.finished || op.renewing) return;
      op.renewing = true;
      void runtime.post("renew_claim", { call_id: op.callId })
        .then(() => {
          op.lastRenewAt = Date.now();
        })
        .catch((error) => {
          // 409/403/404 mean the claim is gone. Transient failures only count
          // once the last confirmed lease is about to lapse.
          if (isClaimRejection(error) || Date.now() - op.lastRenewAt >= CLAIM_LEASE_MS - 5_000) {
            abortAccept("claim-lost");
          }
        })
        .finally(() => {
          op.renewing = false;
        });
    }, CLAIM_HEARTBEAT_MS);
  }, [runtime, abortAccept, stopHeartbeat]);

  const renewClaimStrict = useCallback(async (op: AcceptOperation) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RENEW_RETRIES; attempt += 1) {
      try {
        await abortable(op, runtime.post("renew_claim", { call_id: op.callId }));
        op.lastRenewAt = Date.now();
        return;
      } catch (error) {
        if (error instanceof AcceptAborted) throw error;
        if (isClaimRejection(error)) {
          op.claimLost = true;
          throw new AcceptStepError("claim-lost");
        }
        lastError = error;
      }
    }
    throw lastError;
  }, [runtime, ]);

  /** After a 409 once pre_accept was sent: is the claim still mine? */
  const confirmClaimOwnership = useCallback(async (op: AcceptOperation) => {
    try {
      const detail = await runtime.detail(op.callId);
      const terminal = ["terminated", "failed", "rejected"].includes(detail.call.state);
      if (detail.claim_owned_by_me === true && !terminal) return;
    } catch {
      // Unknown ownership: assume lost so we never close someone else's call.
    }
    op.claimLost = true;
    throw new AcceptStepError("claim-lost");
  }, [runtime, ]);

  const postAfterPreAccept = useCallback(async (
    op: AcceptOperation,
    action: string,
    values: Record<string, unknown>,
  ) => {
    try {
      return await abortable(op, runtime.post(action, values));
    } catch (error) {
      if (isClaimRejection(error)) await confirmClaimOwnership(op);
      throw error;
    }
  }, [runtime, confirmClaimOwnership]);

  /** getUserMedia with a hard timeout; a late grant is stopped immediately. */
  const acquireMicrophone = useCallback((op: AcceptOperation, timeoutMs: number): Promise<MediaStream> => {
    if (!window.isSecureContext || !runtime.hasMicrophoneApi()) {
      return Promise.reject(new Error(t("secureContextRequired")));
    }
    return new Promise<MediaStream>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new AcceptStepError("mic-timeout"));
      }, timeoutMs);
      let pending: Promise<MediaStream>;
      try {
        pending = runtime.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
      } catch (error) {
        window.clearTimeout(timer);
        reject(error);
        return;
      }
      pending.then((stream) => {
        window.clearTimeout(timer);
        if (settled || op.aborted) {
          stopStream(stream);
          if (!settled) {
            settled = true;
            reject(new AcceptAborted(op.abortReason ?? "claim-lost"));
          }
          return;
        }
        settled = true;
        stream.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        localStreamRef.current = stream;
        resolve(stream);
      }, (error) => {
        window.clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }, [runtime, t]);

  const describeAcceptError = useCallback((error: unknown): string => {
    if (error instanceof AcceptAborted) {
      return error.reason === "claim-lost" ? t("claimLost") : t("conversationChanged");
    }
    if (error instanceof AcceptStepError) {
      if (error.code === "claim-lost") return t("claimLost");
      if (error.code === "mic-timeout") return t("microphoneTimedOut");
      return t("offerExpiringSoon");
    }
    if (isMicrophoneDenied(error)) return t("microphoneDenied");
    if (error instanceof CallApiError && error.status === 409) return t("callNoLongerAvailable");
    return error instanceof Error ? error.message : t("callFailed");
  }, [t]);

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
    if (!canUseCalling || !conversation?.id || pollBusyRef.current || activeCallRef.current || uiState !== "idle") return;
    pollBusyRef.current = true;
    try {
      const response = await runtime.fetch("/api/whatsapp/calls", {
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
  }, [runtime, canUseCalling, conversation?.id, uiState]);

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
      if (acceptOpRef.current) {
        // Accepting an incoming call: release the claim and stop every stream.
        abortAccept("conversation-changed");
      } else if (active && !operationRef.current) {
        operationRef.current = true;
        setUiState("ending");
        void runtime.post("terminate", { call_id: active.call_id })
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
  }, [runtime, abortAccept, conversation?.id, resetCall, stopMedia, t]);

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
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      // Releases the claim (or closes the call after pre_accept) and stops media.
      abortAcceptRef.current("unmount");
      const call = activeCallRef.current;
      if (call) {
        void runtime.post("terminate", { call_id: call.call_id });
      }
      stopMedia();
    };
  }, [runtime, stopMedia]);

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
      const peer = runtime.createPeerConnection();
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
      const result = await runtime.post("connect", {
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
          await runtime.post("terminate", { call_id: call.call_id });
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
  }, [runtime, addLocalAudio, attachRemoteAudio, contact, conversation, enableAudio, isPilotContact, permission?.canStartCall, requestMicrophone, resetCall, setCall, stopMedia, t, uiState, waitForRemoteAnswer]);

  const acceptIncoming = useCallback(async () => {
    const incoming = incomingCall;
    if (!incoming || uiState !== "idle" || operationRef.current) return;
    operationRef.current = true;
    // 1. Operation token: single owner of this attempt's claim, media and timers.
    const op = createAcceptOperation(incoming.call_id, conversation?.id ?? null);
    acceptOpRef.current = op;
    // 2. State: claiming. The microphone is NOT touched before the claim is ours.
    setUiState("claiming");
    setErrorMessage(null);
    try {
      // 3-4. Claim, and confirm we are the winner. Losers stop here (zero getUserMedia).
      const claimRequest = runtime.post("claim", { call_id: incoming.call_id });
      // The conversation may change while the claim POST is in flight.
      // Promise.race aborts the UI but cannot cancel a server-side claim.
      // Observe a late success and release only if GET still proves ownership.
      void claimRequest.then(() => {
        if (op.aborted) {
          op.claimed = true;
          op.lastRenewAt = Date.now();
          void finalizeAcceptClaim(op);
        }
      }).catch(() => {
        // An uncertain network result is handled by the request catch below.
      });
      try {
        await abortable(op, claimRequest);
        op.claimed = true;
        op.lastRenewAt = Date.now();
      } catch (claimError) {
        if (!(claimError instanceof AcceptAborted) && !isDefiniteClaimFailure(claimError)) {
          // Network/5xx: the server may have committed. Verify by reading and release
          // only when the claim is provably ours; otherwise the 90 s lease is the
          // residual protection.
          try {
            const check = await runtime.detail(incoming.call_id);
            if (check.claim_owned_by_me === true) op.claimed = true;
          } catch {
            // Unconfirmed: leave the lease to expire.
          }
        }
        throw claimError;
      }
      assertAcceptActive(op);

      // 5-6. Offer SDP and enough validity left to ask for the microphone.
      const detail = await abortable(op, runtime.detail(incoming.call_id));
      assertAcceptActive(op);
      if (detail.claim_owned_by_me === false) {
        op.claimLost = true;
        throw new AcceptStepError("claim-lost");
      }
      if (detail.session?.sdp_type !== "offer" || !detail.session.sdp) {
        throw new Error(t("incomingOfferMissing"));
      }
      const offerExpiresAt = Date.parse(detail.call.session_sdp_expires_at ?? "");
      const micTimeoutMs = Math.min(
        MIC_TIMEOUT_MAX_MS,
        offerExpiresAt - Date.now() - OFFER_SAFETY_MARGIN_MS,
      );
      if (!Number.isFinite(micTimeoutMs) || micTimeoutMs < MIN_MIC_WINDOW_MS) {
        throw new AcceptStepError("offer-expiring");
      }

      // 7. Microphone, once, only for the claim winner.
      setUiState("requesting-media");
      const stream = await abortable(op, acquireMicrophone(op, micTimeoutMs));
      assertAcceptActive(op);

      // 8-9. Renew right after the permission dialog; a refusal aborts (tracks are
      // stopped by the catch below). Only then does the heartbeat start: there is
      // none while the offer is read or the dialog is open.
      await renewClaimStrict(op);
      assertAcceptActive(op);
      startHeartbeat(op);

      // 10-11. PeerConnection and WebRTC negotiation.
      const peer = runtime.createPeerConnection();
      peerRef.current = peer;
      attachRemoteAudio(peer);
      addLocalAudio(peer, stream);
      await abortable(op, peer.setRemoteDescription({ type: "offer", sdp: detail.session.sdp }));
      const answer = await abortable(op, peer.createAnswer());
      await abortable(op, peer.setLocalDescription(answer));
      await abortable(op, waitForIceGathering(peer));
      assertAcceptActive(op);
      const localSdp = peer.localDescription?.sdp;
      if (!localSdp) throw new Error(t("localAnswerMissing"));

      // 12. pre_accept.
      setUiState("connecting");
      op.preAccept = true;
      await postAfterPreAccept(op, "pre_accept", {
        call_id: incoming.call_id,
        session: { sdp_type: "answer", sdp: localSdp },
        conversation_id: conversation?.id,
      });
      assertAcceptActive(op);

      // 13. Wait for the audio connection (the heartbeat keeps the lease alive).
      await abortable(op, waitForPeerConnected(peer));
      assertAcceptActive(op);

      // 14. Renew before accept.
      await renewClaimStrict(op);
      assertAcceptActive(op);

      // 15. Accept and confirm the agent attribution.
      const accepted = await postAfterPreAccept(op, "accept", {
        call_id: incoming.call_id,
        conversation_id: conversation?.id,
      });
      assertAcceptActive(op);
      if (accepted.agent_attribution_recorded !== true && accepted.already_accepted !== true) {
        throw new Error(t("callAcceptanceNotRecorded"));
      }
      await enableAudio();
      assertAcceptActive(op);
      op.finished = true;
      stopHeartbeat(op);
      const acceptedCall = { ...incoming, state: "connected" };
      setCall(acceptedCall);
      setIncomingCall(null);
      setUiState("connected");
    } catch (error) {
      stopHeartbeat(op);
      stopMedia();
      await finalizeAcceptClaim(op);
      const unmounted = unmountedRef.current || (error instanceof AcceptAborted && error.reason === "unmount");
      if (!unmounted) {
        const message = describeAcceptError(error);
        toast.error(message);
        if (op.preAccept && !op.claimLost && op.terminationError) {
          // Keep the call visible for a retry, while releasing all local media.
          setCall({ ...incoming, state: "failed" });
          setIncomingCall(null);
          setUiState("failed");
          setErrorMessage(`${message} · ${op.terminationError}`);
        } else {
          resetCall();
          setErrorMessage(message);
        }
      }
    } finally {
      op.finished = true;
      stopHeartbeat(op);
      if (acceptOpRef.current === op) acceptOpRef.current = null;
      operationRef.current = false;
    }
  }, [
    runtime,
    acquireMicrophone, addLocalAudio, assertAcceptActive, attachRemoteAudio,
    conversation?.id, describeAcceptError, enableAudio, finalizeAcceptClaim, incomingCall,
    postAfterPreAccept, renewClaimStrict, resetCall, setCall, startHeartbeat, stopHeartbeat,
    stopMedia, t, uiState,
  ]);

  const rejectIncoming = useCallback(async () => {
    if (!incomingCall || operationRef.current) return;
    operationRef.current = true;
    setUiState("ending");
    try {
      await runtime.post("reject", {
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
  }, [runtime, conversation?.id, incomingCall, t]);

  const endCall = useCallback(async () => {
    const call = activeCallRef.current;
    if (!call || operationRef.current) return;
    operationRef.current = true;
    setUiState("ending");
    setErrorMessage(null);
    try {
      await runtime.post("terminate", { call_id: call.call_id });
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
  }, [runtime, resetCall, t]);

  const requestPermission = useCallback(async () => {
    if (!contact?.id || operationRef.current || permissionRequesting
      || !permission?.canRequestPermission || !isPilotContact) return;
    operationRef.current = true;
    setPermissionRequesting(true);
    setPermissionError(null);
    try {
      await runtime.post("request_permission", { contact_id: contact.id });
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
  }, [runtime, contact?.id, isPilotContact, permission?.canRequestPermission, permissionRequesting, refreshPermission, t]);

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
      {canUseCalling && isPilotContact && incomingCall && uiState === "idle" ? (
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
      {canUseCalling && (isPilotContact || isPilotActiveCall) && ["connected", "failed"].includes(uiState) && activeCall ? (
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
      {canUseCalling && isPilotContact && !incomingCall && !["connected", "failed"].includes(uiState) && permission?.canStartCall ? (
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
      {canUseCalling && uiState === "idle" && isPilotContact && permission?.status === "no_permission" ? (
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
      {canUseCalling && uiState === "idle" && isPilotContact && permission?.canStartCall ? (
        <span className="hidden text-[11px] text-emerald-600 sm:inline">{t("permissionActive")}</span>
      ) : null}
      {canUseCalling && permissionError && uiState === "idle" && isPilotContact ? (
        <span role="status" className="max-w-40 truncate text-[11px] text-red-500">{permissionError}</span>
      ) : null}
      {canUseCalling && recentCalls.length > 0 && uiState === "idle" ? (
        <details className="max-w-64 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t("history")} ({recentCalls.length})</summary>
          <ul className="mt-1 max-h-48 space-y-2 overflow-y-auto rounded-md border border-border bg-card p-2">
            {recentCalls.slice(0, 8).map((call) => {
              const actors = [
                call.initiated_by_name ? `${t("initiatedBy")}: ${call.initiated_by_name}` : null,
                call.accepted_by_name ? `${t("acceptedBy")}: ${call.accepted_by_name}` : null,
                call.rejected_by_name ? `${t("rejectedBy")}: ${call.rejected_by_name}` : null,
                call.ended_by_name ? `${t("endedBy")}: ${call.ended_by_name}` : null,
              ].filter((value): value is string => Boolean(value));
              return (
                <li key={call.call_id} className="space-y-1 border-b border-border/60 pb-2 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">
                      {call.direction === "USER_INITIATED" ? t("incoming") : t("outgoing")}
                      {call.customer_name ? ` · ${call.customer_name}` : ""}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{call.state.replace(/_/g, " ")}</span>
                  </div>
                  <div className="space-y-0.5 text-[11px] text-muted-foreground">
                    {actors.length > 0 ? actors.map((actor) => <div key={actor}>{actor}</div>) : (
                      <div>{t("unknownAgent")}</div>
                    )}
                    <div>{t("historyDate")}: {formatCallDate(call.created_at)}</div>
                    <div>{t("historyDuration")}: {call.duration_seconds == null ? "—" : formatDuration(call.duration_seconds)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      {canUseCalling && errorMessage && uiState === "idle" ? (
        <span role="status" className="max-w-40 truncate text-[11px] text-red-500">{errorMessage}</span>
      ) : null}
    </div>
  );
}
