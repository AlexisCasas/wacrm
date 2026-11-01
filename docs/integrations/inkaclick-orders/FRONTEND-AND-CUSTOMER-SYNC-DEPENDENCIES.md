# Dependencias entre el frontend de InkaClick (#5), la sincronización de clientes (#6) y WACRM

Estado a 2026-11-01. Repositorio de InkaClick: `InkaClick-Saas`. Sin URLs de despliegue ni datos de clientes (repositorio público).

## 1. Qué es cada pieza
| Pieza | Qué hace | Estado |
|---|---|---|
| Receptor (migración `20261101010000` + función `wacrm-confirmed-orders`) | Recibe pedidos de WACRM, idempotente | Instalado en producción |
| `InkaClick-Saas#5` (frontend) | Muestra «Departamento» y la descripción de pedido como texto seguro | Fusionado en `feature/whatsapp-inbox-crm` a 01:47 UTC y desplegado a Producción (ver §4) |
| `InkaClick-Saas#6` rev. 2 (SQL) | Disparador de clientes con semántica WACRM, histórico conservado, marca `is_test` | Borrador; **sin aplicar** |
| Emisor de WACRM | Envía pedidos; aún **no** envía `is_test` | Apagado (`enabled = FALSE`, sin cron) |

## 2. Dependencias
1. **#5 depende de la migración del receptor** solo para mostrar departamento (columna `departamento`, ya aplicada). Sin ella la vista muestra N/A.
2. **#5 no depende de #6, pero conviene aplicar #6 antes de entregar pedidos reales.** Mientras siga el disparador antiguo, un pedido WACRM (o la edición de uno desde la pantalla de pedidos) recuenta por DNI y sobrescribe el nombre de la ficha del cliente.
3. **`is_test` (en #6) no tiene aún efecto visible en #5:** el listado, sus KPIs y el contador de clientes no filtran pedidos de prueba. Hace falta un cambio de frontend aparte (ocultar o marcar `is_test`, excluirlos de los KPI) y que el **emisor de WACRM envíe `is_test`** (campo en el pedido, formulario o convención). Hasta entonces un pedido de prueba cuenta como un pedido más en listados y KPIs.
4. **Contadores históricos (`customers.total_pedidos`):** son una instantánea histórica, no un recuento; el KPI «pedidos consolidados» de la pantalla de clientes suma esos contadores. #6 nunca los reescribe a la baja (solo para clientes con pedidos WACRM; los clientes solo-ManyChat conservan su comportamiento, incluida la erosión de historia previa). Si se aplicara a ManyChat la misma regla, el KPI dejaría de bajar con cada pedido nuevo de clientes antiguos; es una decisión aparte.
5. **Orden recomendado:** (a) revisar #6 y aplicarla con respaldo previo; (b) añadir `is_test` al emisor y el filtro en el frontend; (c) solo entonces activar WACRM comercialmente. #5 ya está desplegado y es compatible con cualquiera de esos pasos.

## 3. QA visual de #5 (build local con datos sintéticos, 22 comprobaciones)
Ejecutada sobre el código fusionado (árbol idéntico al del Preview probado). Ver `e2e/frontend-qa/`. Resultado: **22/22 PASS**.
- Detalle de un pedido WACRM: producto, cantidad, precio, destino y departamento correctos; la descripción de texto libre aparece como texto (con saltos de línea) y **nunca como enlace**; un `<img onerror>` y un `javascript:` dentro del texto no se ejecutan; la etiqueta es «Descripción del Pedido».
- Un enlace `https://` histórico de ManyChat sigue siendo un enlace (`target=_blank`, `rel="noopener noreferrer"`); un valor `javascript:` histórico no genera enlace ni se ejecuta; un pedido sin descripción muestra N/A.
- La columna «Departamento» se habilita y deshabilita desde «Columnas» sin afectar a las demás; la celda muestra el valor o N/A.
- Edición: se abre y se cancela sin enviar escrituras; navegación listado → clientes → listado sin errores.
- Observaciones (no bloqueantes, preexistentes): el **vendedor no se muestra en el detalle** (solo como columna opcional del listado); el campo de edición de la descripción es de **una línea**, de modo que guardar la edición de un pedido WACRM con texto multilínea aplanaría los saltos de línea; el detalle ofrece «Enviar mensaje de embalaje», que una persona operadora podría pulsar sobre un pedido de prueba.
- Límite: no se probó con la sesión real; la comprobación en producción con datos reales (pedido E2E) queda a cargo de la persona responsable (§5).

## 4. Vercel: versión productiva y reversión
- **Producción actual:** despliegue del commit de fusión de #5 (`c026bf3`, 01:48 UTC, estado success). Su árbol es idéntico al del commit probado en el Preview (`4c685ce`). El Preview del HEAD del PR utilizó ese mismo commit.
- **Qué dispara un despliegue de Producción:** la fusión de un PR en `feature/whatsapp-inbox-crm` **o en `main`** genera uno (precedentes: `d3211d7`, `708fddf`, `eb41e5d`, `c026bf3`). Un push a una rama de trabajo genera solo un Preview. Por eso fusionar #6 en `main` también crea un despliegue de Producción aunque #6 solo cambie SQL y archivos de pruebas. Los despliegues desde `main` construyen el frontend de ejemplo de esa rama, **no** el frontend funcional: antes de fusionar a `main`, confirmar en el panel de Vercel qué rama es la de Producción y si «Auto-assign Production Domains» está activo, y que un despliegue de `main` no reemplace el frontend funcional.
- **Despliegues de Producción conocidos (más reciente primero):** `c026bf3` (feature), `eb41e5d` (main), `708fddf` (main), `d3211d7` (feature, 30-oct). El último con el frontend funcional anterior a #5 es `d3211d7`.
- **Reversión inmediata (panel de Vercel, sin CLI ni token):** proyecto del frontend → *Deployments* → filtrar *Production* → localizar el despliegue **anterior** al de `c026bf3` que sirvió el frontend funcional (el panel lo marca como «Previous Production Deployment» en *Instant Rollback*) → *Instant Rollback* / *Promote to Production*. Verificar: la página de inicio sirve el bundle esperado (`index-*.js`) y los módulos Pedidos, Bandeja WhatsApp y Clientes cargan. No usar un despliegue de `main` como destino sin confirmar que es el frontend funcional.
- **Reversión por git (más lenta, deja trazabilidad):** PR que revierte el commit de fusión (`git revert -m 1 c026bf3`) contra `feature/whatsapp-inbox-crm`; fusionarlo genera un despliegue de Producción con el código anterior.
- El cambio de #5 es solo de visualización: su reversión no afecta a datos.

## 5. Comprobación pendiente con sesión real (persona responsable)
En producción: abrir «Pedidos confirmados», buscar el pedido E2E (`PRUEBA WACRM E2E`) y comprobar producto, precio, destino y departamento; activar y desactivar la columna «Departamento»; abrir un pedido histórico de ManyChat con enlace de descripción y verificar que sigue abriendo; **no pulsar «Guardar cambios» ni «Enviar mensaje de embalaje»**.
