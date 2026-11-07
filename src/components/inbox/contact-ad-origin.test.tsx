// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

import { ContactAdOrigin } from "./contact-ad-origin";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) =>
    (({
      originTitle: "ORIGEN DEL CLIENTE", originMetaAd: "Publicidad en Meta", originAd: "Anuncio", originDetail: "Detalle", originEntry: "Entrada", originEntryValue: "Click a WhatsApp",
      originPlatform: "Plataforma", originViewAd: "Ver anuncio", originNone: "Sin atribución de anuncio", originFacebook: "Facebook", originInstagram: "Instagram",
      originFepWindow: "Ventana gratis de Meta", originFepConfirmed: "Meta confirmó envío sin costo", originFepRemaining: "{time} restantes", originFepEnded: "Ventana gratuita finalizada",
    }) as Record<string, string>)[key]?.replace("{time}", params?.time ?? "") ?? key,
}));

const h = vi.hoisted(() => ({
  rows: {} as Record<string, { headline: string | null; body?: string | null; source_url: string | null }>,
  selects: [] as string[],
  fail: false,
  /** whatsapp_message_pricing rows (already filtered to free_entry_point, ordered by the database) per contact; `fepFail` makes that read fail. */
  fep: {} as Record<string, { expiration_at: string | null }[]>,
  fepFail: false,
  fepQueries: [] as { eq: Record<string, string>; order?: [string, unknown]; limit?: number }[],
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const f: Record<string, string> = {};
      const b: Record<string, unknown> = {
        select: (cols: string) => (h.selects.push(`${table}:${cols}`), table === "whatsapp_message_pricing" && h.fepQueries.push({ eq: f }), b),
        eq: (k: string, v: string) => ((f[k] = v), b),
        order: (col: string, opts: unknown) => ((h.fepQueries.at(-1)!.order = [col, opts]), b),
        limit: (n: number) => {
          const q = h.fepQueries.at(-1)!;
          q.limit = n;
          return Promise.resolve(h.fepFail ? { data: null, error: { message: "x" } } : { data: h.fep[q.eq.contact_id] ?? [], error: null });
        },
        maybeSingle: () => Promise.resolve(h.fail ? { data: null, error: { message: "x" } } : { data: h.rows[f.contact_id] ?? null, error: null }),
      };
      return b;
    },
  }),
}));

beforeEach(() => { h.rows = {}; h.selects = []; h.fail = false; h.fep = {}; h.fepFail = false; h.fepQueries = []; });
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
  it("reads only headline, body and source_url (+ the window's expiration): technical ids never reach the browser", async () => {
    h.rows.c1 = { headline: "X", source_url: null };
    render(<ContactAdOrigin contactId="c1" />);
    await screen.findByText(/Publicidad en Meta/);
    expect(h.selects).toEqual(["contact_ad_attributions:headline, body, source_url", "whatsapp_message_pricing:expiration_at"]);
  });
  it("a failed read shows nothing instead of claiming there is no attribution", async () => {
    h.fail = true;
    const { container } = render(<ContactAdOrigin contactId="c1" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
  it("a generic headline (the page name) plus a specific body: shows both, the body as 'Detalle'", async () => {
    h.rows.c1 = { headline: "Corporación Lorteg del Perú SAC", body: "🔥 Taladro inalámbrico 20V con batería y cargador\n\nPrecio de oferta", source_url: null };
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText("Anuncio: Corporación Lorteg del Perú SAC")).toBeTruthy();
    expect(screen.getByText(/^Detalle: .*Taladro inalámbrico 20V con batería y cargador Precio de oferta/)).toBeTruthy();
    expect(screen.getAllByText("ORIGEN DEL CLIENTE")).toHaveLength(1);
  });
  it("a specific headline without a body: no Detalle line", async () => {
    h.rows.c1 = { headline: "Taladro inalámbrico 20V", body: null, source_url: null };
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText("Anuncio: Taladro inalámbrico 20V")).toBeTruthy();
    expect(screen.queryByText(/Detalle/)).toBeNull();
  });
  it("a body equal to the headline is not repeated", async () => {
    h.rows.c1 = { headline: "Taladro inalámbrico 20V", body: "  taladro inalambrico 20v ", source_url: null };
    render(<ContactAdOrigin contactId="c1" />);
    await screen.findByText("Anuncio: Taladro inalámbrico 20V");
    expect(screen.queryByText(/Detalle/)).toBeNull();
  });
  it("mathematical-bold ad copy is shown as plain letters, and a long body is cut", async () => {
    h.rows.c1 = { headline: "InkaClick", body: "🔥 𝗥𝗢𝗧𝗢𝗠𝗔𝗥𝗧𝗜𝗟𝗟𝗢 𝗧𝗢𝗧𝗔𝗟 𝗜𝗡𝗗𝗨𝗦𝗧𝗥𝗜𝗔𝗟 𝟭𝟬𝟱𝟬𝗪 " + "x".repeat(400), source_url: null };
    render(<ContactAdOrigin contactId="c1" />);
    const line = await screen.findByText(/^Detalle: /);
    expect(line.textContent).toContain("🔥 ROTOMARTILLO TOTAL INDUSTRIAL 1050W");
    expect(line.textContent!.length).toBeLessThan(230);
    expect(line.textContent!.endsWith("…")).toBe(true);
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

describe("ContactAdOrigin: Meta free-entry-point window (only Meta's own evidence)", () => {
  const AD = { headline: "InkaClick", body: "Taladro inalámbrico", source_url: null };
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

  it("an active window with Meta's expiration shows the exact time left", async () => {
    h.rows.c1 = AD; h.fep.c1 = [{ expiration_at: inMs(2 * 86400_000 + 14 * 3600_000 + 30_000) }];
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText(/🟢 Ventana gratis de Meta$/)).toBeTruthy();
    expect(screen.getByText("2 d 14 h restantes")).toBeTruthy();
    expect(screen.getAllByText("ORIGEN DEL CLIENTE")).toHaveLength(1);
  });
  it("under 6 hours left: orange and minutes", async () => {
    h.rows.c1 = AD; h.fep.c1 = [{ expiration_at: inMs(3 * 3600_000 + 20 * 60_000 + 30_000) }];
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText(/🟠 Ventana gratis de Meta$/)).toBeTruthy();
    expect(screen.getByText("3 h 20 min restantes")).toBeTruthy();
  });
  it("a real expiration in the past: 'Ventana gratuita finalizada', no time left", async () => {
    h.rows.c1 = AD; h.fep.c1 = [{ expiration_at: inMs(-3600_000) }];
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText("Ventana gratuita finalizada")).toBeTruthy();
    expect(screen.queryByText(/restantes/)).toBeNull();
  });
  it("FEP pricing but no expiration from Meta: 'Meta confirmó envío sin costo' and nothing else (no 'activa', no counter, no 'finalizada', no colored window)", async () => {
    h.rows.c1 = AD; h.fep.c1 = [{ expiration_at: null }];
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText("Meta confirmó envío sin costo")).toBeTruthy();
    expect(screen.queryByText(/activa/i)).toBeNull();
    expect(screen.queryByText(/restantes|min|\d+ [dh]\b/)).toBeNull();
    expect(screen.queryByText(/finalizada|Ventana gratis/)).toBeNull();
    expect(screen.queryByText(/🟢|🟠/)).toBeNull();
  });
  it("only the referral, no Meta confirmation: no window line at all", async () => {
    h.rows.c1 = AD;
    render(<ContactAdOrigin contactId="c1" />);
    await screen.findByText(/Publicidad en Meta/);
    expect(screen.queryByText(/Ventana|restantes|finalizada/)).toBeNull();
  });
  it("a contact without advertising shows no window and does not even read it", async () => {
    h.fep.nobody = [{ expiration_at: inMs(3600_000) }];
    render(<ContactAdOrigin contactId="nobody" />);
    expect(await screen.findByText("Sin atribución de anuncio")).toBeTruthy();
    expect(screen.queryByText(/Ventana|restantes/)).toBeNull();
    expect(h.fepQueries).toHaveLength(0);
  });
  it("a failed window read leaves the line out instead of claiming anything", async () => {
    h.rows.c1 = AD; h.fep.c1 = [{ expiration_at: inMs(3600_000) }]; h.fepFail = true;
    render(<ContactAdOrigin contactId="c1" />);
    await screen.findByText(/Publicidad en Meta/);
    expect(screen.queryByText(/Ventana|restantes|finalizada/)).toBeNull();
  });
  it("reads ONE window of the contact: free_entry_point rows only, the latest expiration first, one row (never summed)", async () => {
    h.rows.c1 = AD; h.fep.c1 = [{ expiration_at: inMs(2 * 3600_000 + 30_000) }];
    render(<ContactAdOrigin contactId="c1" />);
    await screen.findByText("2 h 0 min restantes");
    expect(h.fepQueries).toEqual([{ eq: { contact_id: "c1", pricing_type: "free_entry_point" }, order: ["expiration_at", { ascending: false, nullsFirst: false }], limit: 1 }]);
  });
  it("the counter reaches zero by itself and turns into 'Ventana gratuita finalizada'", async () => {
    h.rows.c1 = AD; h.fep.c1 = [{ expiration_at: inMs(1500) }];
    render(<ContactAdOrigin contactId="c1" />);
    expect(await screen.findByText("1 min restantes")).toBeTruthy();
    expect(await screen.findByText("Ventana gratuita finalizada", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(/restantes/)).toBeNull();
  });
  it("switching to a contact without a window never keeps the previous contact's window", async () => {
    h.rows.a = AD; h.fep.a = [{ expiration_at: inMs(3600_000 * 30) }]; h.rows.b = AD;
    const { rerender } = render(<ContactAdOrigin contactId="a" />);
    await screen.findByText(/restantes/);
    rerender(<ContactAdOrigin key="b" contactId="b" />);
    await waitFor(() => expect(screen.queryByText(/restantes/)).toBeNull());
    expect(screen.queryByText(/Ventana/)).toBeNull();
  });
});
