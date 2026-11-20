// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CallHistory } from "./call-history";
import type { Profile } from "@/types";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => ({
    history: "Call history",
    outgoing: "Outgoing",
    incoming: "Incoming",
    you: "You",
    unknownAgent: "Agent",
    completed: "Completed",
  }[key] ?? key),
}));

const calls = [{
  id: "session-1",
  phone_number_id: "740434745820831",
  call_id: "wacid.qa-history",
  direction: "BUSINESS_INITIATED" as const,
  contact_id: "contact-1",
  conversation_id: "conversation-1",
  initiated_by_user_id: "agent-1",
  accepted_by_user_id: null,
  rejected_by_user_id: null,
  ended_by_user_id: "agent-1",
  customer_key: "51980942247",
  customer_phone: "51980942247",
  customer_name: "Keyler",
  state: "terminated",
  claimed_by_user_id: null,
  claim_expires_at: null,
  started_at: "2026-11-20T12:00:00.000Z",
  ended_at: "2026-11-20T12:01:00.000Z",
  duration_seconds: 60,
  created_at: "2026-11-20T12:00:00.000Z",
}];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Inbox CallHistory", () => {
  it("loads only the active conversation and shows direction, agent and duration", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ calls }),
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const profile = { user_id: "agent-1", full_name: "Ana Agent" } as Profile;
    const profiles = new Map<string, Profile>([["agent-1", profile]]);

    render(
      <CallHistory
        conversationId="conversation-1"
        profilesByUserId={profiles}
        currentUserId="agent-2"
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/whatsapp/calls?conversation_id=conversation-1",
      expect.objectContaining({ cache: "no-store" }),
    ));
    fireEvent.click(await screen.findByRole("button", { name: /call history/i }));
    expect(await screen.findByText("Outgoing · Ana Agent")).toBeInTheDocument();
    expect(screen.getByText("01:00")).toBeInTheDocument();
  });

  it("labels the current user as You", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ calls }),
    }) as Response));
    const profile = { user_id: "agent-1", full_name: "Ana Agent" } as Profile;

    render(
      <CallHistory
        conversationId="conversation-1"
        profilesByUserId={new Map([["agent-1", profile]])}
        currentUserId="agent-1"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /call history/i }));
    expect(await screen.findByText("Outgoing · You")).toBeInTheDocument();
  });
});
