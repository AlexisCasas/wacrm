# QA integrada local PR-01 + PR-02 + PR-03 + PR-04 (solo local)

Todo es sintético y local. Nada llega a Meta, a un OCR real ni a producción.

| Comando | Qué hace |
|---|---|
| `node scripts/qa/pr04-integrated/seed.cjs create` | Borra el QA previo (solo marcas `qa-pr04`) y crea cuentas, usuarios, chats, pedidos, plantilla y archivos |
| `node scripts/qa/pr04-integrated/seed.cjs validated` | (app encendida) deja el Pedido E en `voucher_validated` por la API real |
| `node scripts/qa/pr04-integrated/seed.cjs scenario safe\|ambiguous\|none` | Reconstruye el pool de carga masiva (valida por API los pedidos pool anteriores) |
| `node scripts/qa/pr04-integrated/seed.cjs cleanup` | Borra SOLO el QA (cuentas `QA-PR04 ...`, usuarios `@qa-pr04.example.invalid`, objetos de storage) |
| `node scripts/qa/pr04-integrated/verify-all.cjs` | Verificación backend (matriz, RLS, cross-account, dispatch, routing, flag). Crea y borra su propio mundo desechable |
| `node scripts/qa/pr04-integrated/smoke-qa-world.cjs` | Humo de solo lectura sobre los usuarios/pedidos QA reales |
| `echo failed > C:\WACRM-LOCAL-QA\meta-mode.txt` | Modo del simulador de Meta: `success` \| `failed` \| `uncertain` (se lee en cada envío) |

Arranque de la app (OCR fake + simulador de Meta; NO se usa Meta real):

```powershell
cd C:\WACRM-LOCAL
$env:ORDER_OCR_PROVIDER = "fake"
$env:NODE_OPTIONS = "--require C:/WACRM-LOCAL/scripts/qa/pr04-integrated/meta-sim.cjs"
npm run dev
```

Estado, fixtures y logs: `C:\WACRM-LOCAL-QA\` (fuera del repo). Log de llamadas simuladas a Meta: `C:\WACRM-LOCAL-QA\meta-sim.log`.
El OCR `fake` devuelve SIEMPRE los mismos valores (DNI 12345678, celular 51900000001, nombre "Cliente Prueba", monto 10.00) para cualquier archivo.
Las órdenes son inmutables: cada `scenario` crea pedidos nuevos y deja los anteriores validados.
