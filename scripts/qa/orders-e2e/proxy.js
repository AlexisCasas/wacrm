// QA-only: Supabase's gateway serves PostgREST under /rest/v1; the bare PostgREST container does not. Strip the prefix and forward.
const http = require("http");
const map = { 3001: "qa-rest-wacrm", 3002: "qa-rest-inka" };
for (const [port, host] of Object.entries(map)) {
  http.createServer((req, res) => {
    const path = req.url.replace(/^\/rest\/v1/, "") || "/";
    const up = http.request({ host, port: 3000, path, method: req.method, headers: { ...req.headers, host: `${host}:3000` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { res.writeHead(502); res.end("{}"); });
    req.pipe(up);
  }).listen(Number(port), "0.0.0.0");
}
