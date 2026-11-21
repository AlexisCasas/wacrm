// @vitest-environment jsdom
/**
 * CALL-03B2.4 — two agents race for the same incoming call.
 *
 * Unlike the shared-fetch tests, every panel here gets its own injected
 * runtime (fetch, getUserMedia, PeerConnection), so each resource is
 * attributed to the panel that requested it. The "server" grants the first
 * claim that reaches it and answers 409 to the other.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallingPanel, type CallingPanelRuntime } from "./calling-panel";
import type { Contact, Conversation } from "@/types";

const translate = vi.hoisted(() => (key: string) => key);
vi.mock("@/hooks/use-can", () => ({ useCan: () => true }));
vi.mock("next-intl", () => ({ useTranslations: () => translate }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const conversation = { id: "a5000000-0000-4000-8000-000000000004" } as Conversation;
const contact = {
  id: "a5000000-0000-4000-8000-000000000003",
  phone: "51980942247",
  name: "Keyler",
  blocked: false,
} as Contact;
const incoming = {
  call_id: "wacid.qa-race",
  conversation_id: conversation.id,
  direction: "USER_INITIATED",
  state: "ringing",
  customer_name: "Keyler",
  customer_phone: "51980942247",
  claim_available: true,
  claimed_at: "2026-11-21T05:00:00.123456+00:00",
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json" },
});

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  closed = false;
  addTrack() { return {} as RTCRtpSender; }
  async setRemoteDescription() { this.connectionState = "connected"; }
  async createAnswer() { return { type: "answer", sdp: "v=0\\r\\n" } as RTCSessionDescriptionInit; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  close() { this.closed = true; this.connectionState = "closed"; }
}

type AgentName = "A" | "B";

interface Agent {
  name: AgentName;
  runtime: Partial<CallingPanelRuntime>;
  track: { enabled: boolean; stop: ReturnType<typeof vi.fn> };
  getUserMedia: ReturnType<typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>>;
  peers: FakePeerConnection[];
  /** HTTP status of every POST this panel sent, in order, by action. */
  statuses: Record<string, number[]>;
}

function createRace() {
  let winner: AgentName | null = null;
  const log: string[] = [];

  const makeAgent = (name: AgentName): Agent => {
    const track = { enabled: false, stop: vi.fn() };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    const agent: Agent = {
      name,
      track,
      peers: [],
      statuses: {},
      getUserMedia: vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>(async () => {
        log.push(`${name}:getUserMedia`);
        return stream;
      }),
      runtime: {},
    };
    agent.runtime = {
      getUserMedia: agent.getUserMedia,
      createPeerConnection: () => {
        const peer = new FakePeerConnection();
        agent.peers.push(peer);
        log.push(`${name}:PeerConnection`);
        return peer as unknown as RTCPeerConnection;
      },
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action: string };
          let response: Response;
          if (body.action === "check_permission") {
            response = json({ permission: { status: "permanent", canStartCall: true, canRequestPermission: false } });
          } else if (body.action === "claim") {
            if (winner === null) winner = name; // first claim to reach the server wins
            response = winner === name
              ? json({ success: true, lease_seconds: 90 })
              : json({ error: "Call is already claimed or no longer available" }, 409);
          } else if (body.action === "renew_claim" || body.action === "pre_accept" || body.action === "release" || body.action === "terminate") {
            response = winner === name ? json({ success: true }) : json({ error: "Not your call" }, 409);
          } else if (body.action === "accept") {
            response = winner === name
              ? json({ success: true, agent_attribution_recorded: true })
              : json({ error: "Not your call" }, 409);
          } else {
            response = json({ success: true });
          }
          (agent.statuses[body.action] ??= []).push(response.status);
          log.push(`${name}:${body.action}:${response.status}`);
          return response;
        }
        if (url.includes("?call_id=")) {
          return json({
            call: { ...incoming, session_sdp_expires_at: new Date(Date.now() + 50_000).toISOString() },
            session: winner === name ? { sdp_type: "offer", sdp: "v=0\\r\\n" } : null,
            claim_owned_by_me: winner === name,
          });
        }
        return json({ calls: [incoming] });
      }) as unknown as typeof fetch,
    };
    return agent;
  };

  return { agents: { A: makeAgent("A"), B: makeAgent("B") }, log, winner: () => winner };
}

describe("two agents race for one incoming call (per-panel instrumentation)", () => {
  const originalSecureContext = window.isSecureContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: originalSecureContext });
  });

  it.each([
    ["A", "B"],
    ["B", "A"],
  ] as Array<[AgentName, AgentName]>)("agent %s clicks first: %s loses without any microphone or WebRTC resource", async (first, second) => {
    const race = createRace();
    const panels = {
      A: render(<CallingPanel pilotEligibleForTests={true} conversation={conversation} contact={contact} runtime={race.agents.A.runtime} />),
      B: render(<CallingPanel pilotEligibleForTests={true} conversation={conversation} contact={contact} runtime={race.agents.B.runtime} />),
    };
    await waitFor(() => {
      expect(within(panels.A.container).getByRole("button", { name: "accept" })).toBeTruthy();
      expect(within(panels.B.container).getByRole("button", { name: "accept" })).toBeTruthy();
    });

    // Both agents click within the same tick; the server sees `first` first.
    fireEvent.click(within(panels[first].container).getByRole("button", { name: "accept" }));
    fireEvent.click(within(panels[second].container).getByRole("button", { name: "accept" }));

    await waitFor(() => expect(panels[first].container.textContent).toContain("00:00"));
    await waitFor(() => expect(panels[second].container.textContent).toContain("callNoLongerAvailable"));

    const win = race.agents[first];
    const lose = race.agents[second];
    const count = (agent: Agent, action: string) => (agent.statuses[action] ?? []).length;

    const table = {
      claim: [win.statuses.claim?.[0], lose.statuses.claim?.[0]],
      getUserMedia: [win.getUserMedia.mock.calls.length, lose.getUserMedia.mock.calls.length],
      PeerConnection: [win.peers.length, lose.peers.length],
      pre_accept: [count(win, "pre_accept"), count(lose, "pre_accept")],
      accept: [count(win, "accept"), count(lose, "accept")],
    };
    console.info(`CONCURRENCY ${first} wins / ${second} loses ${JSON.stringify(table)}`);

    expect(race.winner()).toBe(first);
    expect(table).toEqual({
      claim: [200, 409],
      getUserMedia: [1, 0],
      PeerConnection: [1, 0],
      pre_accept: [1, 0],
      accept: [1, 0],
    });

    // The loser sent nothing after the 409 and holds no media at all.
    expect(Object.keys(lose.statuses).filter((action) => action !== "check_permission")).toEqual(["claim"]);
    expect(lose.track.stop).not.toHaveBeenCalled();
    expect(lose.track.enabled).toBe(false);
    expect(lose.peers).toHaveLength(0);
    // The winner asked for the microphone strictly after its own claim.
    const claimAt = race.log.indexOf(`${first}:claim:200`);
    expect(claimAt).toBeGreaterThanOrEqual(0);
    expect(race.log.indexOf(`${first}:getUserMedia`)).toBeGreaterThan(claimAt);
    expect(race.log).not.toContain(`${second}:getUserMedia`);
    expect(race.log).not.toContain(`${second}:PeerConnection`);
    // Winner keeps its single connected call; nothing was released or terminated.
    expect(win.peers[0].closed).toBe(false);
    expect(count(win, "release") + count(win, "terminate")).toBe(0);
  });

  it("a loser that retries is refused again and still never opens the microphone", async () => {
    const race = createRace();
    const panelA = render(<CallingPanel pilotEligibleForTests={true} conversation={conversation} contact={contact} runtime={race.agents.A.runtime} />);
    const panelB = render(<CallingPanel pilotEligibleForTests={true} conversation={conversation} contact={contact} runtime={race.agents.B.runtime} />);
    await waitFor(() => {
      expect(within(panelA.container).getByRole("button", { name: "accept" })).toBeTruthy();
      expect(within(panelB.container).getByRole("button", { name: "accept" })).toBeTruthy();
    });
    fireEvent.click(within(panelA.container).getByRole("button", { name: "accept" }));
    fireEvent.click(within(panelB.container).getByRole("button", { name: "accept" }));
    await waitFor(() => expect(panelB.container.textContent).toContain("callNoLongerAvailable"));

    const retry = within(panelB.container).queryByRole("button", { name: "accept" });
    if (retry) {
      await act(async () => { fireEvent.click(retry); });
      await waitFor(() => expect(race.agents.B.statuses.claim?.length ?? 0).toBeGreaterThanOrEqual(1));
    }
    expect(race.agents.B.getUserMedia).not.toHaveBeenCalled();
    expect(race.agents.B.peers).toHaveLength(0);
    expect(screen.queryAllByText("00:00").length).toBeLessThanOrEqual(1);
  });
});
