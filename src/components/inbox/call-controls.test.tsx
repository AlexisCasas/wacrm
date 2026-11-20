// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CallControls } from "./call-controls";

const labels: Record<string, string> = {
  call: "Call",
  callContactTitle: "Call {name}",
  callContactDescription: "WhatsApp Calling",
  permissionStatus: "Call permission",
  checkingPermission: "Checking permission",
  permissionPermanent: "Permanent permission",
  permissionTemporary: "Temporary permission",
  permissionMissing: "Permission missing",
  microphoneNotice: "Microphone is requested only after starting",
  startCall: "Start call",
  requestPermission: "Request permission",
  permissionRequestSent: "Permission request sent",
  permissionRequestFailed: "Permission request failed",
  permissionCheckFailed: "Permission check failed",
  cancel: "Cancel",
  callStartFailed: "Call could not be started",
};

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    let value = labels[key] ?? key;
    if (params) {
      for (const [name, replacement] of Object.entries(params)) {
        value = value.replace(`{${name}}`, String(replacement));
      }
    }
    return value;
  },
}));

const fetchMock = vi.fn();
const startCall = vi.fn();

function response(payload: unknown, ok = true) {
  return { ok, json: async () => payload } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  startCall.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Inbox CallControls", () => {
  it("checks permission when opened but starts media only after explicit Start call", async () => {
    fetchMock.mockResolvedValue(response({
      permission: {
        status: "permanent",
        canStartCall: true,
        canRequestPermission: true,
      },
    }));
    startCall.mockResolvedValue(true);

    render(
      <CallControls
        contactId="contact-1"
        conversationId="conversation-1"
        contactName="Keyler"
        onStartCall={startCall}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    await screen.findByRole("button", { name: "Start call" });

    expect(fetchMock).toHaveBeenCalledWith("/api/whatsapp/calls", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "check_permission", contact_id: "contact-1" }),
    }));
    expect(startCall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start call" }));
    await waitFor(() => expect(startCall).toHaveBeenCalledWith({
      contactId: "contact-1",
      conversationId: "conversation-1",
      contactName: "Keyler",
    }));
  });

  it("offers a permission request instead of starting a call without consent", async () => {
    fetchMock
      .mockResolvedValueOnce(response({
        permission: {
          status: "no_permission",
          canStartCall: false,
          canRequestPermission: true,
        },
      }))
      .mockResolvedValueOnce(response({ success: true, message_id: "wamid.qa" }));
    render(
      <CallControls
        contactId="contact-2"
        conversationId="conversation-2"
        contactName="Keyler"
        onStartCall={startCall}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Call" }));
    fireEvent.click(await screen.findByRole("button", { name: "Request permission" }));

    await screen.findByText("Permission request sent");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/whatsapp/calls", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "request_permission", contact_id: "contact-2" }),
    }));
    expect(startCall).not.toHaveBeenCalled();
  });

  it("does not open when the caller action is disabled", () => {
    render(
      <CallControls
        contactId="contact-3"
        conversationId="conversation-3"
        contactName="Keyler"
        disabled
        onStartCall={startCall}
      />,
    );
    expect(screen.getByRole("button", { name: "Call" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
