# Backlog fuera del piloto

- **Comisiones de ManyChat** («BN …», «Pago comisión …» y fórmulas como `=IF(D4>=40,40,"")` de la pestaña «Ventas x vendedor» del libro anterior): **fuera de este piloto**. La pestaña nueva muestra pedidos, líneas, unidades e importe por vendedor, sin comisiones. Si el negocio las quiere, se definen reglas de comisión explícitas en una pestaña aparte alimentada por fórmulas sobre «Registro de pedidos».
- Pestaña histórica «Datos315-2/11/2026-Jhon» del libro anterior: no se migra.
- Reparación asistida de filas alteradas (hoy solo se detecta y se pone el pedido en `dead` con `row_content_mismatch`; un humano decide).
- Alerta push/correo ante `attention` (hoy el cron devuelve HTTP 500 y el script sale con código ≠ 0; la integración con el monitor de 5 min queda por decidir).
