// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useTranslations } from "next-intl";

import { KeywordsInput, AdvertisingMessageInput, AdvertisingLinkSection } from "./flow-builder";
import { manualKeywordsFrom, combineKeywords } from "@/lib/flows/advertising-link";

// ---------------------------------------------------------------------------
// feat/flow-advertising-links (+ design fix)
//
// KeywordsInput must NEVER be given or asked to display/split the
// advertising message — it can legitimately contain commas
// ("Hola, quiero información sobre X, precio, stock y envío"), and this
// field's own commit always re-splits its ENTIRE displayed value on ",".
// The trigger panel is the seam that keeps these separate: it passes
// KeywordsInput only `manualKeywordsFrom(keywords, advertisingMessage)`
// and recombines every change via `combineKeywords`. Since
// TriggerPanel itself isn't exported, the tests below exercise that
// same seam directly — rendering KeywordsInput/AdvertisingMessageInput
// with exactly the props the panel would compute, and (where the spec
// describes the PERSISTED result) composing their onChange output with
// `combineKeywords`/`manualKeywordsFrom` the same way the panel does.
// ---------------------------------------------------------------------------

vi.mock("next-intl", () => ({
  // Identity translator — assertions target the message KEY.
  useTranslations: () => (key: string) => key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

const t = useTranslations("Flows.builder");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("KeywordsInput — still comma-separates, unchanged from before this feature", () => {
  it("parses on blur: trims, drops empties, rejoins with ', '", () => {
    const onChange = vi.fn();
    render(<KeywordsInput keywords={[]} onChange={onChange} t={t} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, {
      target: { value: "WACRM-PILOTO-XTD-001,  support ,,hi" },
    });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(["WACRM-PILOTO-XTD-001", "support", "hi"]);
  });

  it("commits on Enter without inserting a newline", () => {
    const onChange = vi.fn();
    render(<KeywordsInput keywords={[]} onChange={onChange} t={t} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "a, b" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["a", "b"]);
  });
});

describe("Trigger panel seam — KeywordsInput only ever sees the manual subset (spec §A)", () => {
  it("displays only the technical keyword, never the advertising message", () => {
    const keywords = [
      "WACRM-PILOTO-XTD-001",
      "Hola, quiero información sobre Producto A",
    ];
    const advertisingMessage = "Hola, quiero información sobre Producto A";
    const manualKeywords = manualKeywordsFrom(keywords, advertisingMessage);

    const onChange = vi.fn();
    render(<KeywordsInput keywords={manualKeywords} onChange={onChange} t={t} />);

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "WACRM-PILOTO-XTD-001",
    );
  });
});

describe("Trigger panel seam — editing KeywordsInput preserves the ad message intact (spec §B)", () => {
  it("recombining KeywordsInput's output with the unchanged ad message never fragments it", () => {
    const keywords = [
      "WACRM-PILOTO-XTD-001",
      "Hola, quiero información sobre Producto A",
    ];
    const advertisingMessage = "Hola, quiero información sobre Producto A";
    const manualKeywords = manualKeywordsFrom(keywords, advertisingMessage);

    const onChange = vi.fn();
    render(<KeywordsInput keywords={manualKeywords} onChange={onChange} t={t} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "WACRM-PILOTO-XTD-001, soporte" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(["WACRM-PILOTO-XTD-001", "soporte"]);

    // This is exactly what TriggerPanel's onChange callback does with
    // KeywordsInput's output.
    const nextManualKeywords = onChange.mock.calls[0][0] as string[];
    const persisted = combineKeywords(nextManualKeywords, advertisingMessage);
    expect(persisted).toEqual([
      "WACRM-PILOTO-XTD-001",
      "soporte",
      "Hola, quiero información sobre Producto A",
    ]);
  });
});

describe("AdvertisingMessageInput — appends/replaces the message as ONE atomic entry", () => {
  it("adds the trimmed message to the manual keywords on first commit", () => {
    const onChange = vi.fn();
    render(
      <AdvertisingMessageInput
        manualKeywords={["WACRM-PILOTO-XTD-001"]}
        advertisingMessage=""
        onChange={onChange}
        t={t}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "  Hola, quiero información sobre Producto A  " },
    });
    fireEvent.blur(textarea);

    expect(onChange).toHaveBeenCalledWith({
      keywords: ["WACRM-PILOTO-XTD-001", "Hola, quiero información sobre Producto A"],
      advertising_message: "Hola, quiero información sobre Producto A",
    });
  });

  it("changing the message replaces the old one and keeps technical keywords (spec §C)", () => {
    // manualKeywords is what the panel would compute BEFORE this edit —
    // i.e. it already excludes "Producto A", exactly like manualKeywordsFrom
    // would return given the current (pre-change) advertisingMessage.
    const onChange = vi.fn();
    render(
      <AdvertisingMessageInput
        manualKeywords={["WACRM-PILOTO-XTD-001", "soporte"]}
        advertisingMessage="Hola, quiero información sobre Producto A"
        onChange={onChange}
        t={t}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "Hola, quiero información sobre Producto B" },
    });
    fireEvent.blur(textarea);

    expect(onChange).toHaveBeenCalledWith({
      keywords: [
        "WACRM-PILOTO-XTD-001",
        "soporte",
        "Hola, quiero información sobre Producto B",
      ],
      advertising_message: "Hola, quiero información sobre Producto B",
    });
    // No residual "Producto A" anywhere in the persisted result.
    const persisted = onChange.mock.calls[0][0].keywords as string[];
    expect(persisted.some((k) => k.includes("Producto A"))).toBe(false);
  });

  it("clearing the field drops it from keywords and persists no empty string (spec §D)", () => {
    const onChange = vi.fn();
    render(
      <AdvertisingMessageInput
        manualKeywords={["WACRM-PILOTO-XTD-001", "soporte"]}
        advertisingMessage="Producto A"
        onChange={onChange}
        t={t}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.blur(textarea);

    expect(onChange).toHaveBeenCalledWith({
      keywords: ["WACRM-PILOTO-XTD-001", "soporte"],
      advertising_message: undefined,
    });
  });

  it("a message with several commas is persisted as exactly ONE keyword entry (spec §E)", () => {
    const onChange = vi.fn();
    render(
      <AdvertisingMessageInput
        manualKeywords={["WACRM-PILOTO-XTD-001"]}
        advertisingMessage=""
        onChange={onChange}
        t={t}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const message = "Hola, quiero información sobre X, precio, stock y envío";
    fireEvent.change(textarea, { target: { value: message } });
    fireEvent.blur(textarea);

    const persisted = onChange.mock.calls[0][0].keywords as string[];
    expect(persisted).toEqual(["WACRM-PILOTO-XTD-001", message]);
    expect(persisted).toHaveLength(2);
  });

  it("a legacy Flow with no advertising_message renders an empty field without error (spec §F)", () => {
    const onChange = vi.fn();
    render(
      <AdvertisingMessageInput
        manualKeywords={["support", "help"]}
        advertisingMessage=""
        onChange={onChange}
        t={t}
      />,
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("AdvertisingLinkSection — generates and copies the link", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  function mockConfigFetch(response: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve(response),
      }),
    );
  }

  it("builds the exact wa.me URL from display_phone_number + the encoded message", async () => {
    mockConfigFetch({
      connected: true,
      phone_info: { id: "PNID-123", display_phone_number: "+51 915 362 074" },
    });

    render(
      <AdvertisingLinkSection
        advertisingMessage="Hola, quiero información sobre el Combo XTD Taladro + Amoladora"
        t={t}
      />,
    );

    const expected =
      "https://wa.me/51915362074?text=" +
      encodeURIComponent(
        "Hola, quiero información sobre el Combo XTD Taladro + Amoladora",
      );

    await waitFor(() => {
      expect(screen.getByDisplayValue(expected)).toBeInTheDocument();
    });
    // Never surfaces phone_number_id or any other technical identifier.
    expect(screen.queryByText(/PNID-123/)).not.toBeInTheDocument();
  });

  it("Copy uses exactly the generated URL and shows a success toast", async () => {
    mockConfigFetch({
      connected: true,
      phone_info: { display_phone_number: "+51 915 362 074" },
    });
    render(<AdvertisingLinkSection advertisingMessage="Hola" t={t} />);

    const expected = "https://wa.me/51915362074?text=" + encodeURIComponent("Hola");
    await waitFor(() => expect(screen.getByDisplayValue(expected)).toBeInTheDocument());

    fireEvent.click(screen.getByText("advertisingLinkCopy"));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expected);
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("shows a helper instead of a link when there is no advertising message", async () => {
    mockConfigFetch({
      connected: true,
      phone_info: { display_phone_number: "+51 915 362 074" },
    });
    render(<AdvertisingLinkSection advertisingMessage="" t={t} />);

    await waitFor(() => {
      expect(screen.getByText("advertisingLinkNeedsMessage")).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue(/wa\.me/)).not.toBeInTheDocument();
  });

  it("shows a helper instead of a link when the account has no connected WhatsApp number", async () => {
    mockConfigFetch({ connected: false, reason: "no_config" });
    render(<AdvertisingLinkSection advertisingMessage="Hola" t={t} />);

    await waitFor(() => {
      expect(screen.getByText("advertisingLinkNeedsPhone")).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue(/wa\.me/)).not.toBeInTheDocument();
  });

  it("shows a helper instead of a link when the config fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<AdvertisingLinkSection advertisingMessage="Hola" t={t} />);

    await waitFor(() => {
      expect(screen.getByText("advertisingLinkNeedsPhone")).toBeInTheDocument();
    });
  });
});
