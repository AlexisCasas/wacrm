// QA-only main service: routes /<function> to a user worker, and emulates the gateway's verify_jwt (HS256 against JWT_SECRET) when VERIFY_JWT=true.
const SECRET = Deno.env.get("JWT_SECRET")!;
const VERIFY_JWT = Deno.env.get("VERIFY_JWT") === "true";
const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function validJwt(token: string): Promise<boolean> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, b64(s), new TextEncoder().encode(`${h}.${p}`));
}
Deno.serve(async (req: Request) => {
  if (VERIFY_JWT) {
    const t = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!t || !(await validJwt(t).catch(() => false))) return new Response(JSON.stringify({ msg: "Invalid JWT" }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const name = new URL(req.url).pathname.split("/")[1];
  if (!name) return new Response(JSON.stringify({ msg: "missing function name" }), { status: 400 });
  const env = Object.entries(Deno.env.toObject());
  try {
    const worker = await EdgeRuntime.userWorkers.create({ servicePath: `/home/deno/functions/${name}`, memoryLimitMb: 150, workerTimeoutMs: 60000, noModuleCache: false, importMapPath: null, envVars: env });
    return await worker.fetch(req);
  } catch (e) {
    return new Response(JSON.stringify({ msg: String(e) }), { status: 500 });
  }
});
