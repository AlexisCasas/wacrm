// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ select: () => ({ eq: async () => ({ data: [] }) }) }) }) }));

import { ConfirmOrderButton } from "./confirm-order-button";

const contact = { id: "22222222-2222-4222-8222-222222222222", name: "Cliente Sintetico", phone: "900000001" };
const answer = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConfirmOrderButton visibility", () => {
  it("shows the button when the feature is on for the account and there are members to choose from", async () => {
    answer({ enabled: true, sellers: [{ id: "u1", name: "Titular" }] });
    render(<ConfirmOrderButton contact={contact} />);
    await screen.findByText("confirmButton");
  });

  it.each([
    ["feature off for the account", { enabled: false, sellers: [] }],
    ["feature off even if a roster were sent", { enabled: false, sellers: [{ id: "u1", name: "Titular" }] }],
    ["feature on but nobody to choose", { enabled: true, sellers: [] }],
  ])("hides the button: %s", async (_label, body) => {
    answer(body);
    render(<ConfirmOrderButton contact={contact} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("confirmButton")).toBeNull();
  });

  it("hides the button when the lookup fails (403 for a viewer, 500, network)", async () => {
    answer({ error: "forbidden" }, 403);
    const { unmount } = render(<ConfirmOrderButton contact={contact} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("confirmButton")).toBeNull();
    unmount();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<ConfirmOrderButton contact={contact} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("confirmButton")).toBeNull();
  });
});
