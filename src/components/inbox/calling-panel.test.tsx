import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CallingPanel } from "./calling-panel";
import type { Contact, Conversation } from "@/types";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;

  addTrack() {
    return {} as RTCRtpSender;
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
  const originalPeerConnection = global.RTCPeerConnection;
  const originalMediaDevices = navigator.mediaDevices;
  const originalSecureContext = window.isSecureContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mediaTrack.enabled = false;
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
    global.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    global.RTCPeerConnection = originalPeerConnection;
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
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ calls: [] }));

    render(<CallingPanel conversation={conversation} contact={contact} />);

    expect(await screen.findByRole("button", { name: "startCall" })).toBeTruthy();
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
      if (init?.method === "POST") return jsonResponse({ success: true });
      return jsonResponse({ calls: [incoming] });
    });

    render(<CallingPanel conversation={conversation} contact={contact} />);

    expect(await screen.findByText("incomingCall")).toBeTruthy();
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
    expect(postedActions).toEqual(["claim", "pre_accept", "accept"]);
  });

  it("does not offer outgoing calls for contacts without a phone identity", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ calls: [] }));
    render(
      <CallingPanel
        conversation={conversation}
        contact={{ ...contact, phone: "" } as Contact}
      />,
    );
    const button = await screen.findByRole("button", { name: "startCall" });
    expect(button).toHaveProperty("disabled", true);
  });
});
