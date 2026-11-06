# Pedidos `acknowledged` sospechosos de prueba/demo (reporte anonimizado)

Fuente: respaldo de producción de 2026-11-06 15:34Z restaurado en un contenedor local aislado (ya eliminado). Sin nombres, DNI, teléfonos ni textos de clientes. **Actualización:** el titular verificó de forma independiente en InkaClick que `c071235f` y `821d22b1` son registros con `is_test=true` y productos de prueba. La exclusión (`reason='test'`) está preparada en `scripts/ops/orders-sheets/exclude-test-orders.sql` y **no se ha aplicado**; no se cambió el estado de ningún pedido.

Criterio de selección (heurística, solo para localizar candidatos): nombre de cliente, producto o descripción con «prueba/test/demo/qa», o DNI con un solo dígito repetido. Resultado: 2 pedidos, ambos por la palabra «PRUEBA» (palabra completa) en el **nombre del producto**; ninguno por nombre de cliente, descripción ni DNI.

| Ref. (md5, 8) | Mes (Lima) | Hora Lima | Criterio | Cant. | Importe S/ | Líneas | Vendedor | Confirmación→ack | ID InkaClick | Mismo DNI en otros pedidos | Teléfono compartido con otros pedidos `acknowledged` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `c071235f` | 2026-10 | 19 | producto contiene «PRUEBA» | 1 | 1,00 | 0 (tradicional) | presente | 1203 s | sí | 0 | 2 |
| `821d22b1` | 2026-11 | 05 | producto contiene «PRUEBA» | 1 | 110,00 | 0 (tradicional) | presente | 322 s | sí | 0 | 2 |

Lectura (no concluyente): el producto de ambos no aparece en ningún otro pedido; en los dos el teléfono es el mismo que el de otros 2 pedidos `acknowledged`; uno cuesta S/ 1,00 (típico de prueba) y el otro S/ 110,00 (importe de venta plausible). Ambos llegaron a InkaClick. **Confirmado como prueba** por la verificación en InkaClick (arriba). Pendiente solo la autorización para aplicar el script en producción, después de la migración.
