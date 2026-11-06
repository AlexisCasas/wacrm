# Informe QA contra Google Sheets API real (datos sintéticos)

Fecha: 2026-11-06. Cuenta de servicio: `whatscrm-sheets-export@whatscrm-513919.iam.gserviceaccount.com`. Hoja: «QA - WhatsCRM Registro de pedidos Keyler (corrida API real, limpia)». Credenciales cargadas solo en el entorno del proceso de prueba desde un JSON con permisos 600 fuera del repositorio; ninguna se imprimió, se persistió en `.env.local` ni aparece en logs o informes (0 coincidencias de material de clave en logs e informes). No se tocó producción, InkaClick, el contenedor `app`, el cron ni SQL.

| Área | Resultado |
|---|---|
| Archivo JSON | PASS: existe, permisos 600, `type=service_account`, `client_email` esperado, clave PEM bien formada |
| OAuth (JWT RS256) | PASS: HTTP 200, `Bearer`, 3599 s |
| Sheets API habilitada / lectura de la hoja | PASS: metadatos y valores HTTP 200 |
| Escritura | PASS: la prueba escribió con permisos de Editor |
| Corrida 1 (SHA `7ad4170c`) | **Datos PASS, fórmulas FAIL** (ver hallazgo) |
| Corrida 2 (SHA `a5f869e6`) sobre la hoja restaurada | PASS 5/5 pasos |

## Hallazgo de la corrida 1 (corregido)
`values:append` con `INSERT_ROWS` sobre un registro vacío insertó las filas en la fila 2 y **desplazó los rangos abiertos `X2:X`** de todas las fórmulas (vistas y Control leían 0), además de dejar las filas nuevas sin formato de fecha/moneda. Los datos eran correctos (5 filas, 4 pedidos, 8 unidades, S/ 495, 0 duplicados). Solo la API real lo podía revelar. Corrección: `batchUpdate` + `appendCells` (celdas tipadas, formato propio, ocupa las primeras filas en blanco sin insertar) y fórmulas con referencias de columna completa. Prueba de regresión en el cliente (no usa `values:append` ni `INSERT_ROWS`; el texto con `=` queda como texto). La hoja se restauró (filas 2–6 eliminadas, cuadrícula de nuevo en 1000 filas, 0 filas de datos) antes de la corrida 2.

## Corrida 2 (única sobre hoja limpia)
| Paso | Resultado |
|---|---|
| Encabezados (27 columnas) | PASS |
| Escritura + lectura | PASS: 4 líneas añadidas y releídas sin cambios |
| Re-ejecución idempotente | PASS: 0 líneas faltantes, 0 duplicadas |
| Respuesta ambigua + reintento | PASS: la fila existía, 0 escrituras nuevas, 1 fila por clave |
| Conciliación de contenido | PASS: 5/5 líneas, 8/8 unidades, 49 500/49 500 céntimos, huellas OK, 0 filas alteradas |

Validación directa de la hoja (API, lectura): 5 filas, 4 pedidos, 5 claves únicas, **0 duplicadas**, 8 unidades, **S/ 495,00**, suma de importes de pedido S/ 495,00, líneas/unidades/importe de cada pedido consistentes, 0 claves vacías. Formatos correctos (`4/11/2026`, `2026-11-04 10:30:05`, `S/.95.00`; DNI y teléfono como texto).

## Fórmulas
«Control de conciliación»: pedidos 4/4, líneas 5/5, unidades 8/8, importe (líneas) 495/495, importe (pedidos) 495/495, duplicadas 0/0 → «Sin diferencias». «Ventas x producto»: Hidrolavadora 3 u / S/ 285, Nivel láser 4 u / S/ 160, Paquete de discos 1 u / S/ 50 (total 8 u, 5 líneas, S/ 495). «Ventas x vendedor»: QA Dos 2 pedidos / S/ 160, QA Uno 2 pedidos / S/ 335 (total 4 pedidos, S/ 495). Segunda verificación de solo lectura (sin nueva escritura, misma revisión de cuadrícula de 1000 filas): idéntica.

## Condiciones restantes para el despliegue
1. Autorización de migración `20261109000000` y del script `exclude-test-orders.sql`.
2. Hoja definitiva limpia y exclusiva de Keyler compartida con la cuenta de servicio; `order_sheet_destinations` con su ID (el índice único impide reutilizar el archivo).
3. Variables `ORDERS_SHEETS_EXPORT_ENABLED`, `GOOGLE_SHEETS_SA_EMAIL`, `GOOGLE_SHEETS_SA_KEY_B64` en el entorno del servidor y recreación de `app` en ventana tranquila (idealmente junto con otro cambio de imagen).
4. Rebase de la rama sobre `main` actual y nueva validación (prod ejecuta ahora una imagen distinta de las que se rehearsaron; fusionar este PR cambia el árbol de `main`).
5. Carga histórica con `eligible_since=null`, `reconcile` con 0 diferencias y segunda pasada sin cambios; solo entonces el cron.
6. Decidir alerta ante `attention` (HTTP 500 del cron).
