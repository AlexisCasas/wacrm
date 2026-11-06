// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

import { ContactAdOrigin } from "./contact-ad-origin";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({
      originTitle: "ORIGEN DEL CLIENTE", originMetaAd: "Publicidad en Meta", originAd: "Anuncio", originEntry: "Entrada", originEntryValue: "Click a WhatsApp",
      originPlatform: "Plataforma", originViewAd: "Ver anuncio", originNone: "Sin atribución de anuncio", originFacebook: "Facebook", originInstagram: "Instagram",
    })[key] ?? key,
}));

const h = vi.hoisted(() => ({
  rows: {} as Record<string, { headline: string | null; source_url: string | null }>,
  selects: [] as string[],
  fail: false,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const f: Record<string, string> = {};
      const b: Record<string, unknown> = {
        select: (cols: string) => (h.selects.push(`${table}:${cols}`), b),
        eq: (k: string, v: string) => ((f[k] = v), b),
        maybeSingle: () => Promise.resolve(h.fail ? { data: null, error: { message: "x" } } : { data: h.rows[f.contact_id] ?? null, error: null }),
      };
      return b;
    },
  }),
}));

beforeEach(() => { h.rows = {}; h.selects = []; h.fail = false; });
afterEach(() => cleanup());

describe("ContactAdOrigin", () => {
  it("shows Publicidad en Meta, the headline, Click a WhatsApp, the platform and Ver anuncio for an Instagram ad", async () => {
    h.rows.c1 = { headline: "Taladro inalámbrico 20V", source_url: "https://www.instagram.com/p/abc/" };
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText(/Publicidad en Meta/)).toBeTruthy();
    expect(screen.getByText("ORIGEN DEL CLIENTE")).toBeTruthy();
    expect(screen.getByText("Anuncio: Taladro inalámbrico 20V")).toBeTruthy();
    expect(screen.getByText("Entrada: Click a WhatsApp")).toBeTruthy();
    expect(screen.getByText("Plataforma: Instagram")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Ver anuncio/ });
    expect(link.getAttribute("href")).toBe("https://www.instagram.com/p/abc/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("shows Facebook for a facebook.com ad URL", async () => {
    h.rows.c1 = { headline: "X", source_url: "https://www.facebook.com/ads/x" };
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText("Plataforma: Facebook")).toBeTruthy();
  });
  it("without a reliable platform or URL: no Plataforma line, no Ver anuncio, no headline line", async () => {
    h.rows.c1 = { headline: null, source_url: null };
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText(/Publicidad en Meta/)).toBeTruthy();
    expect(screen.getByText("Entrada: Click a WhatsApp")).toBeTruthy();
    expect(screen.queryByText(/Plataforma/)).toBeNull();
    expect(screen.queryByText(/Anuncio:/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("a shortener (fb.me) gives a link but no platform; an unsafe URL gives neither", async () => {
    h.rows.c1 = { headline: "X", source_url: "https://fb.me/abc" };
    h.rows.c2 = { headline: "Y", source_url: "javascript:alert(1)" };
    const { unmount } = render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByRole("link", { name: /Ver anuncio/ })).toBeTruthy();
    expect(screen.queryByText(/Plataforma/)).toBeNull();
    unmount();
    render(<ContactAdOrigin contactId="c2" />);
    expect(await screen.findByText(/Publicidad en Meta/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/Plataforma/)).toBeNull();
  });
  it("without attribution it says 'Sin atribución de anuncio' and assumes nothing", async () => {
    render(<ContactAdOrigin contactId="nobody" />);
    expect(await screen.findByText("Sin atribución de anuncio")).toBeTruthy();
    expect(screen.queryByText(/Publicidad en Meta|orgánic|directo|Facebook|Instagram/)).toBeNull();
  });
  it("reads only headline and source_url: technical ids never reach the browser", async () => {
    h.rows.c1 = { headline: "X", source_url: null };
    render(<ContactAdOrigin contactId="c1" />);
    await screen.findByText(/Publicidad en Meta/);
    expect(h.selects).toEqual(["contact_ad_attributions:headline, source_url"]);
  });
  it("a failed read shows nothing instead of claiming there is no attribution", async () => {
    h.fail = true;
    const { container } = render(<ContactAdOrigin contactId="c1" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
  it("another contact never shows the previous contact's origin", async () => {
    h.rows.a = { headline: "Anuncio A", source_url: null };
    const { rerender } = render(<ContactAdOrigin contactId="a" />);
    await screen.findByText("Anuncio: Anuncio A");
    rerender(<ContactAdOrigin contactId="b" />);
    await waitFor(() => expect(screen.getByText("Sin atribución de anuncio")).toBeTruthy());
    expect(screen.queryByText(/Anuncio A/)).toBeNull();
  });
});
