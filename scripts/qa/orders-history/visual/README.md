# QA visual del panel «Pedidos confirmados»

Compila los componentes **reales** (`OrderHistory`, `ConfirmOrderButton`) con el tema Tailwind real de la app y los textos reales de `messages/es.json`.
Solo se sustituyen las costuras del framework (`next-intl`, el cliente de Supabase y `fetch`); datos sintéticos, sin red ni producción.

```bash
npx vite build -c scripts/qa/orders-history/visual/vite.config.mjs      # salida: scripts/qa/orders-history/visual/dist (o $QA_OUT)
docker run --rm -v "$PWD/scripts/qa/orders-history/visual/dist":/dist:ro -v "$PWD/scripts/qa/orders-history/visual":/work -v /tmp/qa-out:/out \
  mcr.microsoft.com/playwright:v1.49.1-noble bash -lc 'cd /work && npm i playwright@1.49.1 --no-audit --no-fund >/dev/null && (cd /dist && python3 -m http.server 4173 --bind 127.0.0.1 >/dev/null 2>&1 &) && sleep 2 && node qa.mjs'
```
Escenarios: vacío, uno, seis, los siete estados (nombre largo), 50+, error y función apagada; dos temas de acento (la app tiene una sola paleta oscura más temas de acento: `violet`, `amber`, …); columna de 280 px.
Limitación: valida el código con datos simulados; no sustituye revisar la sesión real tras un despliegue autorizado.
