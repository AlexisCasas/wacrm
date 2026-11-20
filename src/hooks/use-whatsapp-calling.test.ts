// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pc: null as Record<string, unknown> | null,
  createPeerConnection: vi.fn(),
  waitForIce: vi.fn(async () => undefined),
  readLocalSdp: vi.fn((pc: unknown, type: string) => type === "offer" ? "v=0\\r\\nOFFER" : "v=0\\r\\nANSWER"),
  stopStream: vi.fn(),
  closePeer: vi.fn(),
  getUserMedia: vi.fn(),
  track: { enabled: true, readyState: "live", stop: vi.fn() },
  fetch: vi.fn(),
}));

vi.mock("@/lib/whatsapp/calling-webrtc", () => ({
  createAudioPeerConnection: (...args: unknown[]) => h.createPeerConnection(...args),
  waitForIceGatheringComplete: (...args: unknown[]) => h.waitForIce(...args),
  readLocalSdp: (...args: unknown[]) => h.readLocalSdp(...args),
  stopCallingMediaStream: (...args: unknown[]) => h.stopStream(...args),
  closeCallingPeerConnection: (...args: unknown[]) => h.closePeer(...args),
}));

import { useWhatsAppCalling } from "./use-whatsapp-calling";

function jsonResponse(payload: unknown, ok = true) {
  return { ok, json: async () => payload } as Response;
}

function makePeerConnection() {
  const pc: Record<string, unknown> = {
    connectionState: "new",
    iceConnectionState: "new",
    iceGatheringState: "complete",
    signalingState: "stable",
    localDescription: null,
    remoteDescription: null,
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0\\r\\nOFFER" })),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "v=0\\r\\nANSWER" })),
    setLocalDescription: vi.fn(async (description: unknown) => { pc.localDescription = description; }),
    setRemoteDescription: vi.fn(async (description: unknown) => { pc.remoteDescription = description; }),
    close: vi.fn(),
  };
  return pc;
}

beforeEach(() => {
  h.pc = makePeerConnection();
  h.createPeerConnection.mockReset().mockImplementation(() => h.pc);
  h.waitForIce.mockReset().mockResolvedValue(undefined);
  h.readLocalSdp.mockReset().mockImplementation((_pc, type) =>
    type === "offer" ? "v=0\\r\\nOFFER" : "v=0\\r\\nANSWER",
  );
  h.stopStream.mockReset().mockImplementation((stream: { getTracks: () => Array<{ stop: () => void }> } | null) => stream?.getTracks().forEach((track) => track.stop()));
  h.closePeer.mockReset().mockImplementation((pc: { close: () => void } | null) => pc?.close());
  h.track.enabled = true;
  h.track.readyState = "live";
  h.track.stop.mockReset();
  h.getUserMedia.mockReset().mockResolvedValue({
    getAudioTracks: () => [h.track],
    getTracks: () => [h.track],
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: h.getUserMedia },
  });

  h.fetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') {
      if (url === "/api/whatsapp/calls") return jsonResponse({ calls: [] });
      if (url.includes("call_id=")) {
        return jsonResponse({
          call: {
            call_id: "wacid.qa-call",
            state: "connected",
            started_at: new Date().toISOString(),
          },
          session: { sdp_type: "answer", sdp: "v=0\\r\\nREMOTE-ANSWER" },
        });
      }
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    switch (body.action) {
      case "check_permission":
        return jsonResponse({
          permission: { status: "permanent", canStartCall: true, canRequestPermission: true },
        });
      case "connect":
        return jsonResponse({ success: true, call_id: "wacid.qa-call" });
      case "claim":
      case "pre_accept":
      case "accept":
      case "reject":
      case "renew_claim":
      case "release":
      case "terminate":
        return jsonResponse({ success: true });
      default:
        return jsonResponse({ calls: [] });
    }
  });
  vi.stubGlobal("fetch", h.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useWhatsAppCalling", () => {
  it("does not request microphone permission until the agent explicitly starts a call", async () => {
    const { result, unmount } = renderHook(() => useWhatsAppCalling());
    await waitFor(() => expect(h.fetch).toHaveBeenCalledWith("/api/whatsapp/calls", expect.anything()));
    expect(h.getUserMedia).not.toHaveBeenCalled();

    let started = false;
    await act(async () => {
      started = await result.current.startOutboundCall({
        contactId: "contact-1",
        conversationId: "conversation-1",
        contactName: "Keyler",
      });
    });

    expect(started).toBe(true);
    expect(h.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(h.fetch).toHaveBeenCalledWith("/api/whatsapp/calls", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"action":"connect"'),
    }));
    await waitFor(() => expect(h.pc?.setRemoteDescription).toHaveBeenCalled());
    unmount();
  });

  it("blocks outbound media when Meta permission is not current", async () => {
    h.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return jsonResponse({ calls: [] });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.action === "check_permission") {
        return jsonResponse({
          permission: { status: "no_permission", canStartCall: false, canRequestPermission: true },
        });
      }
      return jsonResponse({ success: true });
    });
    const { result } = renderHook(() => useWhatsAppCalling());
    let started = true;
    await act(async () => {
      started = await result.current.startOutboundCall({
        contactId: "contact-1",
        conversationId: "conversation-1",
        contactName: "Keyler",
      });
    });
    expect(started).toBe(false);
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(result.current.error).toBe("call_permission_required");
  });

  it("claims and answers an incoming call with one SDP answer for pre_accept and accept", async () => {
    h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if ((!init?.method || init.method === 'GET') && url.includes("call_id=")) {
        return jsonResponse({
          call: { call_id: "wacid.qa-incoming", state: "ringing" },
          session: { sdp_type: "offer", sdp: "v=0\\r\\nREMOTE-OFFER" },
        });
      }
      if (!init?.method || init.method === 'GET') return jsonResponse({ calls: [] });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ success: true, ...(body.action === "connect" ? { call_id: "wacid.qa-call" } : {}) });
    });
    const { result, unmount } = renderHook(() => useWhatsAppCalling());
    const call = {
      id: "session-1",
      phone_number_id: "740434745820831",
      call_id: "wacid.qa-incoming",
      direction: "USER_INITIATED" as const,
      contact_id: "contact-1",
      conversation_id: "conversation-1",
      initiated_by_user_id: null,
      accepted_by_user_id: null,
      rejected_by_user_id: null,
      ended_by_user_id: null,
      customer_key: "51980942247",
      customer_phone: "51980942247",
      customer_name: "Keyler",
      state: "offered",
      claimed_by_user_id: null,
      claim_expires_at: null,
      started_at: null,
      ended_at: null,
      duration_seconds: null,
      created_at: new Date().toISOString(),
    };

    let accepted = false;
    await act(async () => { accepted = await result.current.acceptIncomingCall(call); });
    expect(accepted).toBe(true);
    const postBodies = h.fetch.mock.calls
      .filter(([, init]) => Boolean(init))
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(postBodies.map((body) => body.action)).toEqual(expect.arrayContaining(["claim", "pre_accept", "accept"]));
    const preAccept = postBodies.find((body) => body.action === "pre_accept");
    const accept = postBodies.find((body) => body.action === "accept");
    expect(preAccept?.session).toEqual({ sdp_type: "answer", sdp: "v=0\\r\\nANSWER" });
    expect(accept?.session).toBeUndefined();
    expect(h.pc?.setRemoteDescription).toHaveBeenCalledWith({
      type: "offer",
      sdp: "v=0\\r\\nREMOTE-OFFER",
    });
    unmount();
  });

  it("mutes local audio tracks and terminates the active call", async () => {
    const { result, unmount } = renderHook(() => useWhatsAppCalling());
    await act(async () => {
      await result.current.startOutboundCall({
        contactId: "contact-1",
        conversationId: "conversation-1",
        contactName: "Keyler",
      });
    });
    act(() => result.current.toggleMute());
    expect(h.track.enabled).toBe(false);

    let ended = false;
    await act(async () => { ended = await result.current.endActiveCall(); });
    expect(ended).toBe(true);
    expect(h.fetch).toHaveBeenCalledWith("/api/whatsapp/calls", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"action":"terminate"'),
    }));
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.pc?.close).toHaveBeenCalled();
    unmount();
  });
});
