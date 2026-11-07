// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";

import { useContactFepWindow } from "./use-contact-fep-window";
import { formatRemaining } from "@/lib/whatsapp/fep-window";

const h = vi.hoisted(() => ({
  ads: {} as Record<string, { headline: string | null; source_url: string | null } | null>,
  fep: {} as Record<string, { expiration_at: string | null }[]>,
  attributionReads: 0,
  pricingReads: 0,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const f: Record<string, string> = {};
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (k: string, v: string) => ((f[k] = v), b),
        order: () => b,
        limit: () => (h.pricingReads++, Promise.resolve({ data: h.fep[f.contact_id] ?? [], error: null })),
        maybeSingle: () => (table === "contact_ad_attributions" && h.attributionReads++, Promise.resolve({ data: h.ads[f.contact_id] ?? null, error: null })),
      };
      return b;
    },
  }),
}));

/** Stands in for the header badge and the sidebar: two consumers of the same contact. */
function Badge({ id, name }: { id: string; name: string }) {
  const { fepWindow } = useContactFepWindow(id);
  return <span data-testid={name}>{fepWindow.kind === "countdown" ? formatRemaining(fepWindow.remainingMs) : fepWindow.kind}</span>;
}
function Pair({ id }: { id: string }) {
  return <><Badge id={id} name="top" /><Badge id={id} name="side" /></>;
}

const T0 = new Date("2026-11-07T12:00:00Z").getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  Object.assign(h, { ads: {}, fep: {}, attributionReads: 0, pricingReads: 0 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const text = (id: string) => screen.getByTestId(id).textContent;

describe("useContactFepWindow shared between header badge and sidebar", () => {
  it("active window: both show the same time with ONE read, and tick together", async () => {
    h.ads.c1 = { headline: "x", source_url: null };
    h.fep.c1 = [{ expiration_at: iso(T0 + (6 * 1440 + 23 * 60 + 30) * 60_000) }];
    render(<Pair id="c1" />);
    await flush();
    expect(text("top")).toBe("6 d 23 h");
    expect(text("side")).toBe("6 d 23 h");
    expect(h.attributionReads).toBe(1);
    expect(h.pricingReads).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(31 * 60_000); });
    expect(text("top")).toBe("6 d 22 h");
    expect(text("side")).toBe("6 d 22 h");
  });

  it("window expired: both switch to 'ended' at the same moment", async () => {
    h.ads.c1 = { headline: "x", source_url: null };
    h.fep.c1 = [{ expiration_at: iso(T0 + 90_000) }];
    render(<Pair id="c1" />);
    await flush();
    expect(text("top")).toBe("1 min");
    await act(async () => { await vi.advanceTimersByTimeAsync(91_000); });
    expect(text("top")).toBe("ended");
    expect(text("side")).toBe("ended");
  });

  it("no Meta data (no ad / no pricing row): nothing is invented", async () => {
    h.ads.c1 = null;
    h.ads.c2 = { headline: "x", source_url: null };
    render(<><Badge id="c1" name="top" /><Badge id="c2" name="side" /></>);
    await flush();
    expect(text("top")).toBe("none");
    expect(text("side")).toBe("none");
  });

  it("conversation switch: the new contact's window replaces the previous one, never mixed", async () => {
    h.ads.a = { headline: "x", source_url: null };
    h.ads.b = { headline: "y", source_url: null };
    h.fep.a = [{ expiration_at: iso(T0 + 5 * 3600_000) }];
    h.fep.b = [{ expiration_at: iso(T0 + 50 * 3600_000) }];
    function Switch() {
      const [id, setId] = useState("a");
      return <><button onClick={() => setId("b")}>go</button><Pair id={id} /></>;
    }
    render(<Switch />);
    await flush();
    expect(text("top")).toBe("5 h 0 min");
    await act(async () => { screen.getByText("go").click(); });
    expect(text("top")).not.toBe("5 h 0 min"); // never the previous contact's time
    await flush();
    expect(text("top")).toBe("2 d 2 h");
    expect(text("side")).toBe("2 d 2 h");
  });
});
