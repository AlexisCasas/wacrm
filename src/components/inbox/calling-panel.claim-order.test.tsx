// @vitest-environment jsdom
/**
 * CALL-03B2.4 — claim before microphone.
 *
 * The order of events is the contract: the claim winner is decided by the
 * server BEFORE any getUserMedia() prompt, the lease is renewed after the
 * permission dialog and before accept, and every abort path releases what it
 * owns (and never touches a call that now belongs to someone else).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallingPanel } from "./calling-panel";
import type { Contact, Conversation } from "@/types";

const translate = vi.hoisted(() => (key: string) => key);

vi.mock("@/hooks/use-can", () => ({ useCan: () => true }));
vi.mock("next-intl", () => ({ useTranslations: () => translate }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const mediaTrack = { enabled: false, stop: vi.fn() };
const mediaStream = {
  getAudioTracks: () => [mediaTrack],
  getTracks: () => [mediaTrack],
} as unknown as MediaStream;

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  static autoConnect = true;
  static iceDelayMs = 0;
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = false;

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }
  addTrack() {
    return {} as RTCRtpSender;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0\\r\\n" } as RTCSessionDescriptionInit;
  }
  async setRemoteDescription() {
    if (FakePeerConnection.autoConnect) this.connectionState = "connected";
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0\\r\\n" } as RTCSessionDescriptionInit;
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    if (FakePeerConnection.iceDelayMs > 0) {
      this.iceGatheringState = "gathering";
      setTimeout(() => {
        this.iceGatheringState = "complete";
        this.dispatchEvent(new Event("icegatheringstatechange"));
      }, FakePeerConnection.iceDelayMs);
    }
  }
  connect() {
    this.connectionState = "connected";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

const conversation = { id: "a4000000-0000-4000-8000-000000000004" } as Conversation;
const otherConversation = { id: "a4000000-0000-4000-8000-0000000000ff" } as Conversation;
const contact = {
  id: "a4000000-0000-4000-8000-000000000003",
  phone: "51980942247",
  name: "Keyler",
  blocked: false,
} as Contact;

const incoming = {
  call_id: "wacid.qa-claim-order",
  conversation_id: conversation.id,
  direction: "USER_INITIATED",
  state: "ringing",
  customer_name: "Keyler",
  customer_phone: "51980942247",
  claim_available: true,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type PostHandler = (body: Record<string, unknown>, nth: number) => Response | Promise<Response>;

interface Harness {
  events: string[];
  /** Date.now() of every POST, per action. */
  times: Record<string, number[]>;
  posts: Array<{ action: string; body: Record<string, unknown> }>;
  count: (action: string) => number;
  gumCount: () => number;
}

/** Fake Calling API + microphone that records one global, ordered event log. */
function installHarness(options: {
  offerMs?: number;
  post?: Record<string, PostHandler>;
  detail?: (nth: number) => Response | Promise<Response>;
  gum?: () => Promise<MediaStream>;
} = {}): Harness {
  const events: string[] = [];
  const times: Record<string, number[]> = {};
  const posts: Harness["posts"] = [];
  let detailCalls = 0;
  const offerMs = options.offerMs ?? 50_000;

  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => {
    events.push("gum");
    return options.gum ? options.gum() : Promise.resolve(mediaStream);
  });

  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const action = String(body.action);
      events.push(action);
      (times[action] ??= []).push(Date.now());
      posts.push({ action, body });
      const nth = posts.filter((post) => post.action === action).length;
      const handler = options.post?.[action];
      if (handler) return handler(body, nth);
      if (action === "check_permission") {
        return json({ permission: { status: "permanent", canStartCall: true, canRequestPermission: false } });
      }
      return json({ success: true, agent_attribution_recorded: true });
    }
    if (url.includes("?call_id=")) {
      events.push("detail");
      detailCalls += 1;
      if (options.detail) return options.detail(detailCalls);
      return json({
        call: { ...incoming, session_sdp_expires_at: new Date(Date.now() + offerMs).toISOString() },
        session: { sdp_type: "offer", sdp: "v=0\\r\\n" },
        claim_owned_by_me: true,
      });
    }
    return json({ calls: [incoming] });
  });

  return {
    events,
    times,
    posts,
    count: (action) => posts.filter((post) => post.action === action).length,
    gumCount: () => events.filter((event) => event === "gum").length,
  };
}

const conflict = (message: string) => json({ error: message }, 409);

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function acceptButton() {
  return screen.findByRole("button", { name: "accept" });
}

/** RTL's findBy* needs real timers; under fake timers poll the DOM by flushing. */
async function acceptButtonFake() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await flush();
    const found = screen.queryByRole("button", { name: "accept" });
    if (found) return found;
  }
  throw new Error("accept button never rendered");
}

describe("CallingPanel — claim before microphone (CALL-03B2.4)", () => {
  const originalFetch = global.fetch;
  const originalMediaDevices = navigator.mediaDevices;
  const originalSecureContext = window.isSecureContext;

  beforeEach(() => {
    vi.clearAllMocks();
    FakePeerConnection.instances = [];
    FakePeerConnection.autoConnect = true;
    FakePeerConnection.iceDelayMs = 0;
    mediaTrack.enabled = false;
    mediaTrack.stop.mockClear();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(mediaStream) },
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: originalMediaDevices });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: originalSecureContext });
  });

  it("claims first, asks for the microphone once, renews after the dialog and again before accept", async () => {
    const harness = installHarness();
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(screen.getByText("00:00")).toBeTruthy());
    const flow = harness.events.filter((event) => event !== "check_permission");
    expect(flow).toEqual(["claim", "detail", "gum", "renew_claim", "pre_accept", "renew_claim", "accept"]);
    expect(harness.gumCount()).toBe(1);
    expect(harness.events.indexOf("claim")).toBeLessThan(harness.events.indexOf("gum"));
    expect(harness.events.indexOf("gum")).toBeLessThan(harness.events.indexOf("pre_accept"));
    expect(harness.count("release")).toBe(0);
    expect(harness.count("terminate")).toBe(0);
  });

  it("never asks the loser for the microphone when the claim is rejected (409)", async () => {
    const harness = installHarness({ post: { claim: () => conflict("Call is already claimed") } });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("callNoLongerAvailable"));
    expect(harness.gumCount()).toBe(0);
    expect(harness.count("release")).toBe(0);
    expect(harness.count("renew_claim")).toBe(0);
    expect(harness.count("pre_accept")).toBe(0);
    expect(harness.count("terminate")).toBe(0);
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(mediaTrack.stop).not.toHaveBeenCalled();
  });

  it("two agents click Accept at the same time: one winner, loser has zero getUserMedia", async () => {
    // Both panels share the global fetch; the server grants the first claim only.
    const harness = installHarness({
      post: { claim: (_body, nth) => (nth === 1 ? json({ success: true, lease_seconds: 90 }) : conflict("Call is already claimed")) },
    });
    const first = render(<CallingPanel conversation={conversation} contact={contact} />);
    const second = render(<CallingPanel conversation={conversation} contact={contact} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "accept" })).toHaveLength(2));
    const buttons = screen.getAllByRole("button", { name: "accept" });

    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);

    await waitFor(() => expect(first.container.textContent).toContain("00:00"));
    expect(second.container.textContent).toContain("callNoLongerAvailable");
    expect(harness.count("claim")).toBe(2);
    expect(harness.gumCount()).toBe(1);
    expect(harness.count("pre_accept")).toBe(1);
    expect(harness.count("accept")).toBe(1);
    expect(harness.count("release")).toBe(0);
    expect(FakePeerConnection.instances).toHaveLength(1);
    // The only microphone request happened after the winning claim.
    expect(harness.events.indexOf("gum")).toBeGreaterThan(harness.events.indexOf("claim"));
  });

  it("releases the claim, sends no terminate and builds no PeerConnection when the microphone is denied", async () => {
    const harness = installHarness({
      gum: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("microphoneDenied"));
    expect(harness.count("release")).toBe(1);
    expect(harness.count("terminate")).toBe(0);
    expect(harness.count("pre_accept")).toBe(0);
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(harness.events.indexOf("release")).toBeGreaterThan(harness.events.indexOf("gum"));
  });

  it("does not ask for the microphone when the offer has too little validity left, and releases", async () => {
    const harness = installHarness({ offerMs: 18_000 }); // 18 s - 15 s margin = 3 s < 5 s minimum
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("offerExpiringSoon"));
    expect(harness.gumCount()).toBe(0);
    expect(harness.count("release")).toBe(1);
    expect(harness.count("pre_accept")).toBe(0);
    expect(FakePeerConnection.instances).toHaveLength(0);
  });

  it("fails closed when the offer expiry is unknown", async () => {
    const harness = installHarness({
      detail: () => json({
        call: { ...incoming },
        session: { sdp_type: "offer", sdp: "v=0\\r\\n" },
        claim_owned_by_me: true,
      }),
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("offerExpiringSoon"));
    expect(harness.gumCount()).toBe(0);
    expect(harness.count("release")).toBe(1);
  });

  it("times out a hanging permission dialog at 30 s, releases, and stops a late stream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let grant: (stream: MediaStream) => void = () => {};
    const harness = installHarness({
      offerMs: 120_000,
      gum: () => new Promise<MediaStream>((resolve) => { grant = resolve; }),
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButtonFake());
    await flush();
    expect(harness.gumCount()).toBe(1);

    await advance(29_000);
    expect(harness.count("release")).toBe(0);
    await advance(1_000);
    await flush();
    expect(harness.count("release")).toBe(1);
    expect(screen.getByRole("status").textContent).toBe("microphoneTimedOut");
    expect(harness.count("terminate")).toBe(0);
    // No heartbeat exists while the offer is read or the dialog is open.
    expect(harness.count("renew_claim")).toBe(0);

    // The user finally grants the dialog: tracks must be stopped, nothing built.
    await act(async () => { grant(mediaStream); });
    await flush();
    expect(mediaTrack.stop).toHaveBeenCalledTimes(1);
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(harness.count("pre_accept")).toBe(0);
  });

  it("limits the dialog to offer-remaining minus 15 s when that is shorter than 30 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const harness = installHarness({
      offerMs: 40_000, // timeout = min(30 s, 40 s - 15 s) = 25 s
      gum: () => new Promise<MediaStream>(() => {}),
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButtonFake());
    await flush();

    await advance(24_000);
    expect(harness.count("release")).toBe(0);
    await advance(1_000);
    await flush();
    expect(harness.count("release")).toBe(1);
    expect(screen.getByRole("status").textContent).toBe("microphoneTimedOut");
  });

  it("aborts on a conversation change during the dialog: releases, no PeerConnection, late stream stopped", async () => {
    let grant: (stream: MediaStream) => void = () => {};
    const harness = installHarness({ gum: () => new Promise<MediaStream>((resolve) => { grant = resolve; }) });
    const view = render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());
    await waitFor(() => expect(harness.gumCount()).toBe(1));

    view.rerender(<CallingPanel conversation={otherConversation} contact={contact} />);
    await waitFor(() => expect(harness.count("release")).toBe(1));
    expect(harness.count("terminate")).toBe(0);

    await act(async () => { grant(mediaStream); });
    await waitFor(() => expect(mediaTrack.stop).toHaveBeenCalledTimes(1));
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(harness.count("pre_accept")).toBe(0);
  });

  it("releases the claim and stops a late stream when the panel unmounts during the dialog", async () => {
    let grant: (stream: MediaStream) => void = () => {};
    const harness = installHarness({ gum: () => new Promise<MediaStream>((resolve) => { grant = resolve; }) });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());
    await waitFor(() => expect(harness.gumCount()).toBe(1));

    view.unmount();
    await waitFor(() => expect(harness.count("release")).toBe(1));
    expect(harness.count("terminate")).toBe(0);

    await act(async () => { grant(mediaStream); });
    await waitFor(() => expect(mediaTrack.stop).toHaveBeenCalledTimes(1));
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not ask for the microphone after a network error on claim, and releases a claim the server did acquire", async () => {
    const harness = installHarness({
      post: { claim: () => { throw new TypeError("Failed to fetch"); } },
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(harness.count("release")).toBe(1));
    expect(harness.gumCount()).toBe(0);
    // Verified by reading the call (claim_owned_by_me) before releasing.
    expect(harness.events.indexOf("detail")).toBeLessThan(harness.events.indexOf("release"));
    expect(harness.count("pre_accept")).toBe(0);
  });

  it("leaves the 90 s lease as residual protection when the claim outcome cannot be confirmed", async () => {
    const harness = installHarness({
      post: { claim: () => { throw new TypeError("Failed to fetch"); } },
      detail: () => { throw new TypeError("Failed to fetch"); },
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(harness.gumCount()).toBe(0);
    // Unprovable ownership: never issue a release that could clear someone else's lease.
    expect(harness.count("release")).toBe(0);
    expect(harness.count("terminate")).toBe(0);
  });

  it("releases (no terminate) when the lease is lost while the dialog was open: renew is refused", async () => {
    const harness = installHarness({
      post: { renew_claim: () => conflict("Call claim has expired or is no longer owned by you") },
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("claimLost"));
    expect(harness.gumCount()).toBe(1);
    expect(harness.count("pre_accept")).toBe(0);
    // Lost claim: do not release or terminate the new owner's call.
    expect(harness.count("release")).toBe(0);
    expect(harness.count("terminate")).toBe(0);
    expect(mediaTrack.stop).toHaveBeenCalled();
    expect(FakePeerConnection.instances).toHaveLength(0);
  });

  it("starts the heartbeat only after the post-permission renew, then renews before accept", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    FakePeerConnection.autoConnect = false;
    FakePeerConnection.iceDelayMs = 10_000; // slow ICE: the negotiation outlasts one heartbeat period
    let grant: (stream: MediaStream) => void = () => {};
    const harness = installHarness({
      offerMs: 120_000,
      gum: () => new Promise<MediaStream>((resolve) => { grant = resolve; }),
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButtonFake());
    const t0 = Date.now();
    await flush();

    await advance(20_000); // the permission dialog is open for 20 s
    expect(harness.count("renew_claim")).toBe(0); // no heartbeat while the dialog is open
    await act(async () => { grant(mediaStream); });
    await flush(); // T = 20 s: renew right after the permission, heartbeat starts
    expect(harness.count("renew_claim")).toBe(1);
    expect(harness.count("pre_accept")).toBe(0); // still gathering ICE

    await advance(10_000); // T = 30 s: ICE done, pre_accept
    await flush();
    expect(harness.count("pre_accept")).toBe(1);
    await advance(20_000); // T = 50 s: first heartbeat beat (20 s + 30 s)
    await flush();
    expect(harness.count("renew_claim")).toBe(2);
    expect(harness.count("accept")).toBe(0);

    await advance(5_000); // T = 55 s: connection established
    await act(async () => { FakePeerConnection.instances[0].connect(); });
    await flush();
    expect(harness.count("renew_claim")).toBe(3); // mandatory renew before accept
    expect(harness.count("accept")).toBe(1);
    expect(harness.events.slice(-2)).toEqual(["renew_claim", "accept"]);
    expect(screen.getByText("00:00")).toBeTruthy();
    expect((harness.times.renew_claim ?? []).map((time) => Math.round((time - t0) / 1000))).toEqual([20, 50, 55]);

    // The heartbeat stops once the call is accepted.
    await advance(120_000);
    expect(harness.count("renew_claim")).toBe(3);
  });

  it("stops locally without terminate when the heartbeat reports the claim lost during negotiation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    FakePeerConnection.autoConnect = false;
    FakePeerConnection.iceDelayMs = 10_000;
    let grant: (stream: MediaStream) => void = () => {};
    const harness = installHarness({
      offerMs: 120_000,
      gum: () => new Promise<MediaStream>((resolve) => { grant = resolve; }),
      post: {
        renew_claim: (_body, nth) => (nth === 1 ? json({ success: true }) : conflict("Call claim has expired or is no longer owned by you")),
      },
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButtonFake());
    await flush();
    await advance(20_000);
    await act(async () => { grant(mediaStream); });
    await flush();
    await advance(10_000);
    await flush();
    expect(harness.count("pre_accept")).toBe(1);

    await advance(20_000); // heartbeat beat at 20 s + 30 s is refused (409)
    await flush();

    expect(screen.getByRole("status").textContent).toBe("claimLost");
    expect(harness.count("terminate")).toBe(0);
    expect(harness.count("release")).toBe(0);
    expect(FakePeerConnection.instances[0].closed).toBe(true);
    expect(mediaTrack.stop).toHaveBeenCalled();
    expect(harness.count("accept")).toBe(0);
  });

  it("does not terminate when another agent took over: accept is refused and the claim is no longer mine", async () => {
    const harness = installHarness({
      post: { accept: () => conflict("This incoming call is already terminal") },
      detail: (nth) => (nth === 1
        ? json({
          call: { ...incoming, session_sdp_expires_at: new Date(Date.now() + 50_000).toISOString() },
          session: { sdp_type: "offer", sdp: "v=0\\r\\n" },
          claim_owned_by_me: true,
        })
        : json({ call: { ...incoming, state: "rejected" }, session: null, claim_owned_by_me: false })),
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("claimLost"));
    expect(harness.count("accept")).toBe(1);
    expect(harness.count("terminate")).toBe(0);
    expect(harness.count("release")).toBe(0);
    expect(mediaTrack.stop).toHaveBeenCalled();
    expect(FakePeerConnection.instances[0].closed).toBe(true);
  });

  it("closes the call with terminate (not release) when pre_accept fails and the claim is still mine", async () => {
    const harness = installHarness({
      post: { pre_accept: () => conflict("This incoming call is no longer awaiting acceptance") },
    });
    render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());

    await waitFor(() => expect(harness.count("terminate")).toBe(1));
    expect(harness.count("release")).toBe(0);
    expect(harness.count("accept")).toBe(0);
    expect(mediaTrack.stop).toHaveBeenCalled();
  });

  it("closes the call safely with terminate when the conversation changes after pre_accept", async () => {
    FakePeerConnection.autoConnect = false;
    const harness = installHarness();
    const view = render(<CallingPanel conversation={conversation} contact={contact} />);
    fireEvent.click(await acceptButton());
    await waitFor(() => expect(harness.count("pre_accept")).toBe(1));

    view.rerender(<CallingPanel conversation={otherConversation} contact={contact} />);
    await waitFor(() => expect(harness.count("terminate")).toBe(1));
    expect(harness.count("release")).toBe(0);
    expect(harness.count("accept")).toBe(0);
    await waitFor(() => expect(FakePeerConnection.instances[0].closed).toBe(true));
    expect(mediaTrack.stop).toHaveBeenCalled();
  });

  it("stores no agent SDP (no pre_accept) on any abort that happens before negotiation", async () => {
    const scenarios: Array<[string, Parameters<typeof installHarness>[0]]> = [
      ["claim rejected", { post: { claim: () => conflict("Call is already claimed") } }],
      ["microphone denied", { gum: () => Promise.reject(new DOMException("denied", "NotAllowedError")) }],
      ["offer expiring", { offerMs: 10_000 }],
      ["renew refused", { post: { renew_claim: () => conflict("lost") } }],
    ];
    for (const [name, options] of scenarios) {
      cleanup();
      FakePeerConnection.instances = [];
      const harness = installHarness(options);
      render(<CallingPanel conversation={conversation} contact={contact} />);
      fireEvent.click(await acceptButton());
      await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
      expect(harness.count("pre_accept"), name).toBe(0);
      expect(harness.count("accept"), name).toBe(0);
      expect(FakePeerConnection.instances, name).toHaveLength(0);
    }
  });

  describe("never acts on a call that now belongs to another agent", () => {
    const claimedByOther = () => json({
      call: { ...incoming, claimed_by_user_id: "agent-b", claim_expires_at: new Date(Date.now() + 60_000).toISOString() },
      session: null,
      claim_owned_by_me: false,
    });
    const mineAgain = () => json({
      call: { ...incoming, claimed_by_user_id: "agent-a", claim_expires_at: new Date(Date.now() + 60_000).toISOString() },
      session: null,
      claim_owned_by_me: true,
    });
    const nobody = () => json({
      call: { ...incoming, claimed_by_user_id: null, claim_expires_at: null },
      session: null,
      claim_owned_by_me: false,
    });
    const firstDetail = () => json({
      call: { ...incoming, session_sdp_expires_at: new Date(Date.now() + 120_000).toISOString() },
      session: { sdp_type: "offer", sdp: "v=0\\r\\n" },
      claim_owned_by_me: true,
    });

    it("does not release a fresh but transferred lease during the microphone dialog", async () => {
      let grant: (stream: MediaStream) => void = () => {};
      const harness = installHarness({
        gum: () => new Promise<MediaStream>((resolve) => { grant = resolve; }),
        detail: (nth) => (nth === 1 ? firstDetail() : claimedByOther()),
      });
      const view = render(<CallingPanel conversation={conversation} contact={contact} />);
      fireEvent.click(await acceptButton());
      await waitFor(() => expect(harness.gumCount()).toBe(1));
      // No clock jump: the client must not trust a newly confirmed 90 s lease.
      view.rerender(<CallingPanel conversation={otherConversation} contact={contact} />);
      await waitFor(() => expect(harness.events.filter((event) => event === "detail")).toHaveLength(2));
      expect(harness.count("release")).toBe(0);
      expect(harness.count("terminate")).toBe(0);
      await act(async () => { grant(mediaStream); });
      expect(mediaTrack.stop).toHaveBeenCalledTimes(1);
    });

    it("does not terminate a recently acquired claim transferred after pre_accept", async () => {
      FakePeerConnection.autoConnect = false;
      const harness = installHarness({ detail: (nth) => (nth === 1 ? firstDetail() : claimedByOther()) });
      const view = render(<CallingPanel conversation={conversation} contact={contact} />);
      fireEvent.click(await acceptButton());
      await waitFor(() => expect(harness.count("pre_accept")).toBe(1));
      view.rerender(<CallingPanel conversation={otherConversation} contact={contact} />);
      await waitFor(() => expect(harness.events.filter((event) => event === "detail")).toHaveLength(2));
      await waitFor(() => expect(FakePeerConnection.instances[0].closed).toBe(true));
      expect(harness.count("terminate")).toBe(0);
      expect(harness.count("release")).toBe(0);
    });

    async function abortDuringDialogAfterLeaseExpired(later: () => Response) {
      vi.useFakeTimers({ toFake: ["Date"] }); // real timers for RTL; only the clock jumps
      let grant: (stream: MediaStream) => void = () => {};
      const harness = installHarness({
        gum: () => new Promise<MediaStream>((resolve) => { grant = resolve; }),
        detail: (nth) => (nth === 1 ? firstDetail() : later()),
      });
      const view = render(<CallingPanel conversation={conversation} contact={contact} />);
      fireEvent.click(await acceptButton());
      await waitFor(() => expect(harness.gumCount()).toBe(1));
      vi.setSystemTime(Date.now() + 100_000); // the 90 s lease lapsed while the dialog sat open
      view.rerender(<CallingPanel conversation={otherConversation} contact={contact} />);
      return { harness, grant: () => act(async () => { grant(mediaStream); }) };
    }

    it("does not release an expired lease that another agent now holds (an admin release would clear it)", async () => {
      const { harness, grant } = await abortDuringDialogAfterLeaseExpired(claimedByOther);
      await waitFor(() => expect(harness.events.filter((event) => event === "detail")).toHaveLength(2));
      expect(harness.count("release")).toBe(0);
      expect(harness.count("terminate")).toBe(0);
      await grant();
      expect(mediaTrack.stop).toHaveBeenCalledTimes(1);
    });

    it("does not release when ownership cannot be read after the lease expired", async () => {
      const { harness } = await abortDuringDialogAfterLeaseExpired(() => { throw new TypeError("Failed to fetch"); });
      await waitFor(() => expect(harness.events.filter((event) => event === "detail")).toHaveLength(2));
      expect(harness.count("release")).toBe(0);
    });

    it("releases an expired lease only after reading that it is still mine", async () => {
      const { harness } = await abortDuringDialogAfterLeaseExpired(mineAgain);
      await waitFor(() => expect(harness.count("release")).toBe(1));
      expect(harness.events.indexOf("release")).toBeGreaterThan(harness.events.lastIndexOf("detail") - 1);
    });

    async function abortAfterPreAcceptWithStaleLease(later: () => Response) {
      vi.useFakeTimers({ toFake: ["Date"] });
      FakePeerConnection.autoConnect = false;
      const harness = installHarness({ detail: (nth) => (nth === 1 ? firstDetail() : later()) });
      const view = render(<CallingPanel conversation={conversation} contact={contact} />);
      fireEvent.click(await acceptButton());
      await waitFor(() => expect(harness.count("pre_accept")).toBe(1));
      vi.setSystemTime(Date.now() + 100_000);
      view.rerender(<CallingPanel conversation={otherConversation} contact={contact} />);
      return harness;
    }

    it("does not terminate after pre_accept when another agent holds the call (lease expired for me)", async () => {
      const harness = await abortAfterPreAcceptWithStaleLease(claimedByOther);
      await waitFor(() => expect(harness.events.filter((event) => event === "detail")).toHaveLength(2));
      await waitFor(() => expect(FakePeerConnection.instances[0].closed).toBe(true));
      expect(harness.count("terminate")).toBe(0);
      expect(harness.count("release")).toBe(0);
    });

    it("does not terminate after pre_accept when ownership cannot be read", async () => {
      const harness = await abortAfterPreAcceptWithStaleLease(() => { throw new TypeError("Failed to fetch"); });
      await waitFor(() => expect(FakePeerConnection.instances[0].closed).toBe(true));
      await waitFor(() => expect(harness.events.filter((event) => event === "detail")).toHaveLength(2));
      expect(harness.count("terminate")).toBe(0);
    });

    it("does not terminate after pre_accept if its lease is free/expired; SDP expiry handles cleanup", async () => {
      const harness = await abortAfterPreAcceptWithStaleLease(nobody);
      await waitFor(() => expect(harness.events.filter((event) => event === "detail")).toHaveLength(2));
      expect(harness.count("terminate")).toBe(0);
      expect(harness.count("release")).toBe(0);
    });
  });
});
