// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CallingPanel } from "./calling-panel";
import type { Contact, Conversation } from "@/types";

const translate = vi.hoisted(() => (key: string) => key);

vi.mock("next-intl", () => ({
  useTranslations: () => translate,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

const mediaTrack = {
  enabled: false,
  stop: vi.fn(),
};

const mediaStream = {
  getAudioTracks: () => [mediaTrack],
  getTracks: () => [mediaTrack],
} as unknown as MediaStream;

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;

  addTrack() {
    return {} as RTCRtpSender;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\\r\\n" };
  }

  async setRemoteDescription() {
    this.connectionState = "connected";
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\\r\\n" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }

  close() {
    this.connectionState = "closed";
  }
}

const conversation = {
  id: "a3000000-0000-4000-8000-000000000004",
} as Conversation;

const contact = {
  id: "a3000000-0000-4000-8000-000000000003",
  phone: "51980942247",
  name: "Keyler",
  blocked: false,
} as Contact;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CallingPanel", () => {
  const originalFetch = global.fetch;
  const originalMediaDevices = navigator.mediaDevices;
  const originalSecureContext = window.isSecureContext;

  beforeEach(() => {
    vi.clearAllMocks();
    FakePeerConnection.instances = [];
    mediaTrack.enabled = false;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    mediaTrack.stop.mockClear();
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(mediaStream),
      },
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: originalSecureContext,
    });
  });

  it("does not request microphone access while the Inbox thread is merely open", async () => {
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({
          permission: { status: "permanent", canStartCall: true, canRequestPermission: false },
        });
      }
      return jsonResponse({ calls: [] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);

    expect(await screen.findByRole("button", { name: "call" })).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("accepts an incoming call only after an explicit click and keeps audio muted until accept", async () => {
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    const incoming = {
      call_id: "wacid.qa-incoming",
      conversation_id: conversation.id,
      direction: "USER_INITIATED",
      state: "ringing",
      customer_name: "Keyler",
      customer_phone: "51980942247",
      claim_available: true,
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?call_id=")) {
        return jsonResponse({
          call: incoming,
          session: { sdp_type: "offer", sdp: "v=0\\r\\n" },
        });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "accept") {
          return jsonResponse({ success: true, agent_attribution_recorded: true });
        }
        return jsonResponse({ success: true });
      }
      return jsonResponse({ calls: [incoming] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);

    expect(await screen.findByText("Keyler")).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(screen.getByText("00:00")).toBeTruthy();
    });
    expect(mediaTrack.enabled).toBe(true);

    const postedActions = vi.mocked(global.fetch).mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).action);
    expect(postedActions).toEqual(["check_permission", "claim", "pre_accept", "accept"]);
  });

  it("keeps audio disabled and terminates if acceptance attribution is not confirmed", async () => {
    const incoming = {
      call_id: "wacid.qa-accept-audit",
      conversation_id: conversation.id,
      direction: "USER_INITIATED",
      state: "ringing",
      customer_name: "Keyler",
      customer_phone: "51980942247",
      claim_available: true,
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?call_id=")) {
        return jsonResponse({
          call: incoming,
          session: { sdp_type: "offer", sdp: "v=0\\r\\n" },
        });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "accept") {
          return new Response(JSON.stringify({
            success: true,
            agent_attribution_recorded: false,
          }), { status: 202 });
        }
        return jsonResponse({ success: true });
      }
      return jsonResponse({ calls: [incoming] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await screen.findByRole("button", { name: "accept" }));

    await waitFor(() => {
      const actions = vi.mocked(global.fetch).mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)).action);
      expect(actions).toContain("terminate");
    });
    expect(mediaTrack.enabled).toBe(false);
    expect(screen.queryByText("00:00")).toBeNull();
  });

  it("starts an outbound call only after current customer permission is confirmed", async () => {
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "check_permission") {
          return jsonResponse({
            permission: { status: "permanent", canStartCall: true, canRequestPermission: false },
          });
        }
        if (body.action === "connect") {
          expect(body.conversation_id).toBe(conversation.id);
          expect(body.session.sdp_type).toBe("offer");
          return jsonResponse({ success: true, call_id: "wacid.qa-outbound" });
        }
        return jsonResponse({ success: true });
      }
      if (url.includes("?call_id=")) {
        return jsonResponse({
          call: {
            call_id: "wacid.qa-outbound",
            conversation_id: conversation.id,
            direction: "BUSINESS_INITIATED",
            state: "connected",
          },
          session: { sdp_type: "answer", sdp: "v=0\\r\\n" },
        });
      }
      return jsonResponse({ calls: [] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);
    const button = await screen.findByRole("button", { name: "call" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText("00:00")).toBeTruthy());
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(mediaTrack.enabled).toBe(true);
    const posted = vi.mocked(global.fetch).mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).action);
    expect(posted).toEqual(["check_permission", "connect"]);
  });

  it("sends a customer consent request only after an explicit click", async () => {
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "check_permission") {
          return jsonResponse({
            permission: { status: "no_permission", canStartCall: false, canRequestPermission: true },
          });
        }
        return jsonResponse({ success: true, message_id: "wamid.qa-permission" });
      }
      return jsonResponse({ calls: [] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);
    const requestButton = await screen.findByRole("button", { name: "requestPermission" });
    fireEvent.click(requestButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "permissionRequestSent" })).toBeTruthy();
    });
    const posted = vi.mocked(global.fetch).mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).action);
    expect(posted).toEqual(["check_permission", "request_permission", "check_permission"]);
  });

  it("does not attempt connect when browser microphone permission is denied", async () => {
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    getUserMedia.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "check_permission") {
          return jsonResponse({
            permission: { status: "permanent", canStartCall: true, canRequestPermission: false },
          });
        }
        return jsonResponse({ success: true });
      }
      return jsonResponse({ calls: [] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);
    const button = await screen.findByRole("button", { name: "call" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const actions = vi.mocked(global.fetch).mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).action);
    expect(actions).not.toContain("connect");
  });

  it("rejects an incoming call without opening the microphone", async () => {
    const incoming = {
      call_id: "wacid.qa-reject",
      conversation_id: conversation.id,
      direction: "USER_INITIATED",
      state: "ringing",
      customer_name: "Keyler",
      customer_phone: "51980942247",
      claim_available: true,
    };
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ success: true });
      return jsonResponse({ calls: [incoming] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await screen.findByRole("button", { name: "reject" }));

    await waitFor(() => {
      const actions = vi.mocked(global.fetch).mock.calls
        .filter(([, callInit]) => callInit?.method === "POST")
        .map(([, callInit]) => JSON.parse(String(callInit?.body)).action);
      expect(actions).toContain("reject");
    });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("does not send pre_accept when another agent already owns the incoming call", async () => {
    const incoming = {
      call_id: "wacid.qa-claimed",
      conversation_id: conversation.id,
      direction: "USER_INITIATED",
      state: "ringing",
      customer_name: "Keyler",
      customer_phone: "51980942247",
      claim_available: true,
    };
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "claim") {
          return new Response(JSON.stringify({ error: "Call is already claimed" }), { status: 409 });
        }
        return jsonResponse({ success: true });
      }
      return jsonResponse({ calls: [incoming] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await screen.findByRole("button", { name: "accept" }));

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    const actions = vi.mocked(global.fetch).mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)).action);
    expect(actions).toContain("claim");
    expect(actions).not.toContain("pre_accept");
    expect(actions).not.toContain("accept");
  });

  it("terminates an active call after WebRTC enters failed state", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "check_permission") {
          return jsonResponse({
            permission: { status: "permanent", canStartCall: true, canRequestPermission: false },
          });
        }
        if (body.action === "connect") return jsonResponse({ call_id: "wacid.qa-disconnect" });
        return jsonResponse({ success: true });
      }
      if (url.includes("?call_id=")) {
        return jsonResponse({
          call: { call_id: "wacid.qa-disconnect", conversation_id: conversation.id, state: "connected" },
          session: { sdp_type: "answer", sdp: "v=0\\r\\n" },
        });
      }
      return jsonResponse({ calls: [] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);
    const button = await screen.findByRole("button", { name: "call" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await screen.findByText("00:00");

    const peer = FakePeerConnection.instances[0];
    peer.connectionState = "failed";
    peer.dispatchEvent(new Event("connectionstatechange"));

    await waitFor(() => {
      const actions = vi.mocked(global.fetch).mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)).action);
      expect(actions).toContain("terminate");
    });
    expect(mediaTrack.stop).toHaveBeenCalled();
  });

  it("terminates the active call when the agent switches conversations", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        if (body.action === "check_permission") {
          return jsonResponse({
            permission: { status: "permanent", canStartCall: true, canRequestPermission: false },
          });
        }
        if (body.action === "connect") return jsonResponse({ call_id: "wacid.qa-switch" });
        return jsonResponse({ success: true });
      }
      if (url.includes("?call_id=")) {
        return jsonResponse({
          call: { call_id: "wacid.qa-switch", conversation_id: conversation.id, state: "connected" },
          session: { sdp_type: "answer", sdp: "v=0\\r\\n" },
        });
      }
      return jsonResponse({ calls: [] });
    });

    const view = render(<CallingPanel conversation={conversation} contact={contact} />);
    const button = await screen.findByRole("button", { name: "call" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await screen.findByText("00:00");

    const nextConversation = { ...conversation, id: "a3000000-0000-4000-8000-000000000099" } as Conversation;
    view.rerender(<CallingPanel conversation={nextConversation} contact={contact} />);

    await waitFor(() => {
      const actions = vi.mocked(global.fetch).mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)).action);
      expect(actions).toContain("terminate");
    });
    expect(mediaTrack.stop).toHaveBeenCalled();
  });

  it("does not offer outgoing calls for contacts without a phone identity", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ calls: [] }));
    render(
      <CallingPanel
        conversation={conversation}
        contact={{ ...contact, phone: "" } as Contact}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "call" })).toBeNull();
    });
  });
});
