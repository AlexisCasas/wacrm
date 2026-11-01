# QA visual del módulo «Pedidos confirmados» de InkaClick (build local, datos sintéticos)

Renderiza el **build real** del frontend de InkaClick en Chromium sin cabeza (imagen oficial de Playwright) con las llamadas a Supabase y al API **simuladas**: nada sale a producción, no hay credenciales ni datos personales. Cubre: columna Departamento (habilitar/deshabilitar), detalle de un pedido WACRM (texto libre, vectores XSS), enlace HTTP(S) histórico de ManyChat, valor `javascript:` histórico, edición sin guardar y navegación.

```bash
# en un checkout de InkaClick-Saas en el commit a probar:
VITE_SUPABASE_URL=http://sb.test VITE_SUPABASE_PUBLISHABLE_KEY=pk_test VITE_API_BASE_URL=http://api.test npx vite build --outDir /tmp/qa-dist
docker run --rm -v /tmp/qa-dist:/dist:ro -v "$PWD":/work -v /tmp/qa-out:/out mcr.microsoft.com/playwright:v1.49.1-noble \
  bash -lc 'cd /work && npm i playwright@1.49.1 --no-audit --no-fund >/dev/null && (cd /dist && python3 -m http.server 4173 >/dev/null 2>&1 &) && sleep 2 && node qa.mjs'
```
Las capturas quedan en `/tmp/qa-out`. Limitación: valida el código y su comportamiento con datos simulados; no sustituye una comprobación con la sesión real en el Preview/producción.
