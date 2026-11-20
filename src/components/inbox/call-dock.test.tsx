// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CallDock } from "./call-dock";
import type { CallingCallRecord, ActiveCallingSession } from "@/hooks/use-whatsapp-calling";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const incomingCall: CallingCallRecord = {
  id: "session-1",
  phone_number_id: "740434745820831",
  call_id: "wacid.qa-incoming",
  direction: "USER_INITIATED",
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
  claim_available: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Inbox CallDock", () => {
  it("shows an incoming call and exposes explicit accept/reject actions", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <CallDock
        incomingCalls={[incomingCall]}
        activeCall={null}
        remoteStream={null}
        muted={false}
        busy={false}
        error={null}
        onAccept={onAccept}
        onReject={onReject}
        onEnd={vi.fn()}
        onToggleMute={vi.fn()}
        onClearError={vi.fn()}
      />,
    );

    expect(screen.getByText("incomingCall")).toBeInTheDocument();
    expect(screen.getByText("Keyler")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(onAccept).toHaveBeenCalledWith(incomingCall);
    expect(onReject).toHaveBeenCalledWith(incomingCall);
  });

  it("shows active call controls and reports the current connection state", () => {
    const activeCall: ActiveCallingSession = {
      callId: "wacid.qa-active",
      conversationId: "conversation-1",
      contactId: "contact-1",
      contactName: "Keyler",
      direction: "BUSINESS_INITIATED",
      state: "connected",
      connectionState: "connected",
      startedAt: new Date(Date.now() - 5000).toISOString(),
    };
    const onEnd = vi.fn();
    const onToggleMute = vi.fn();
    render(
      <CallDock
        incomingCalls={[]}
        activeCall={activeCall}
        remoteStream={null}
        muted={false}
        busy={false}
        error={null}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onEnd={onEnd}
        onToggleMute={onToggleMute}
        onClearError={vi.fn()}
      />,
    );

    expect(screen.getByText("Keyler")).toBeInTheDocument();
    expect(screen.getByText(/connected/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "mute" }));
    fireEvent.click(screen.getByRole("button", { name: /end/i }));
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("shows an explicit audio-unlock action when autoplay is blocked", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("autoplay blocked"));
    const stream = {} as MediaStream;
    const activeCall: ActiveCallingSession = {
      callId: "wacid.qa-active",
      conversationId: "conversation-1",
      contactId: "contact-1",
      contactName: "Keyler",
      direction: "BUSINESS_INITIATED",
      state: "connected",
      connectionState: "connected",
      startedAt: new Date().toISOString(),
    };
    render(
      <CallDock
        incomingCalls={[]}
        activeCall={activeCall}
        remoteStream={stream}
        muted={false}
        busy={false}
        error={null}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onEnd={vi.fn()}
        onToggleMute={vi.fn()}
        onClearError={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: /enableAudio/i })).toBeInTheDocument();
    expect(play).toHaveBeenCalled();
  });
});
