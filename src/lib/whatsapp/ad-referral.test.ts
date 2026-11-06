import { describe, expect, it } from "vitest";
import { adDetailText, adPlatformFromUrl, displayAdText, normalizeAdReferral, safeAdUrl } from "./ad-referral";

describe("normalizeAdReferral", () => {
  it("keeps the documented ad fields, trimmed", () => {
    expect(
      normalizeAdReferral({
        source_type: "ad", source_id: " 123 ", source_url: "https://fb.me/x", headline: " Taladro ", body: "b", media_type: "image",
        image_url: "https://i/1.jpg", video_url: "https://v/1.mp4", thumbnail_url: "https://t/1.jpg", ctwa_clid: "clid",
      }),
    ).toEqual({
      source_type: "ad", source_id: "123", source_url: "https://fb.me/x", headline: "Taladro", body: "b", media_type: "image",
      image_url: "https://i/1.jpg", video_url: "https://v/1.mp4", thumbnail_url: "https://t/1.jpg", ctwa_clid: "clid",
    });
  });
  it("missing fields stay null: nothing is assumed", () => {
    expect(normalizeAdReferral({ source_type: "ad", source_id: "1" })).toMatchObject({ headline: null, source_url: null, ctwa_clid: null });
  });
  it("no referral, a post referral, an empty ad and non-objects are not attribution", () => {
    expect(normalizeAdReferral(undefined)).toBeNull();
    expect(normalizeAdReferral(null)).toBeNull();
    expect(normalizeAdReferral("ad")).toBeNull();
    expect(normalizeAdReferral({ source_type: "post", source_id: "1" })).toBeNull();
    expect(normalizeAdReferral({ source_type: "ad" })).toBeNull();
    expect(normalizeAdReferral({ source_id: "1" })).toBeNull();
  });
  it("non-string fields are dropped and long ones capped", () => {
    const r = normalizeAdReferral({ source_type: "ad", source_id: 5, headline: "x".repeat(1000), ctwa_clid: "c" });
    expect(r?.source_id).toBeNull();
    expect(r?.headline).toHaveLength(300);
  });
});

describe("adPlatformFromUrl", () => {
  it("is instagram / facebook only when the host says so", () => {
    expect(adPlatformFromUrl("https://www.instagram.com/p/abc/")).toBe("instagram");
    expect(adPlatformFromUrl("https://instagram.com/p/abc/")).toBe("instagram");
    expect(adPlatformFromUrl("https://www.facebook.com/ads/xyz")).toBe("facebook");
    expect(adPlatformFromUrl("https://m.facebook.com/x")).toBe("facebook");
  });
  it("is unknown for shorteners, look-alikes, http, garbage and nothing", () => {
    expect(adPlatformFromUrl("https://fb.me/abc")).toBeNull();
    expect(adPlatformFromUrl("https://notinstagram.com/p")).toBeNull();
    expect(adPlatformFromUrl("https://instagram.com.evil.test/p")).toBeNull();
    expect(adPlatformFromUrl("http://www.instagram.com/p")).toBeNull();
    expect(adPlatformFromUrl("not a url")).toBeNull();
    expect(adPlatformFromUrl(null)).toBeNull();
  });
});

describe("safeAdUrl", () => {
  it("allows https links on Meta hosts", () => {
    expect(safeAdUrl("https://www.facebook.com/ads/x")).toBe("https://www.facebook.com/ads/x");
    expect(safeAdUrl("https://fb.me/abc")).toBe("https://fb.me/abc");
    expect(safeAdUrl("https://www.instagram.com/p/a/")).toBe("https://www.instagram.com/p/a/");
  });
  it("rejects everything else", () => {
    for (const u of ["javascript:alert(1)", "http://www.facebook.com/x", "https://evil.test/x", "https://facebook.com.evil.test/x", "data:text/html,x", "", null, undefined]) {
      expect(safeAdUrl(u as string | null | undefined)).toBeNull();
    }
  });
});

describe("displayAdText / adDetailText", () => {
  it("turns mathematical-bold letters into plain ones and collapses whitespace, without inventing text", () => {
    expect(displayAdText("🔥 𝗥𝗢𝗧𝗢𝗠𝗔𝗥𝗧𝗜𝗟𝗟𝗢  𝟭𝟬𝟱𝟬𝗪\n\n𝗣𝗿𝗲𝗰𝗶𝗼")).toBe("🔥 ROTOMARTILLO 1050W Precio");
    expect(displayAdText(null)).toBe("");
  });
  it("the body is the detail when the headline is generic", () => {
    expect(adDetailText("Corporación Lorteg del Perú SAC", "Taladro inalámbrico 20V con batería")).toBe("Taladro inalámbrico 20V con batería");
  });
  it("no body, or a body that adds nothing, gives no detail", () => {
    expect(adDetailText("Taladro", null)).toBeNull();
    expect(adDetailText("Taladro", "   ")).toBeNull();
    expect(adDetailText("Taladro inalámbrico 20V", "TALADRO inalambrico 20V!")).toBeNull();
    expect(adDetailText("Taladro inalámbrico 20V", "Taladro inalámbrico 20V.")).toBeNull();
  });
  it("a body that merely contains a short headline is still detail", () => {
    expect(adDetailText("InkaClick", "InkaClick: Taladro inalámbrico con juego completo a solo S/95")).not.toBeNull();
  });
  it("a missing headline still shows the body; long bodies are cut at 200 characters", () => {
    expect(adDetailText(null, "Lavadora industrial 15 kg")).toBe("Lavadora industrial 15 kg");
    const long = adDetailText("X", "a".repeat(500))!;
    expect(long.length).toBe(201);
    expect(long.endsWith("…")).toBe(true);
  });
});
