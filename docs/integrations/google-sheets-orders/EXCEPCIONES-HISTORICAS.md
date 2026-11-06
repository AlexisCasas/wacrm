# Pedidos `acknowledged` sospechosos de prueba/demo (reporte anonimizado)

Fuente: respaldo de producción de 2026-11-06 15:34Z restaurado en un contenedor local aislado (ya eliminado). Sin nombres, DNI, teléfonos ni textos de clientes. **No se excluyó ni se cambió el estado de ningún pedido.** La decisión es manual (evidencia mínima abajo) y, si se decide excluir, se registra con `order_sheet_exclusions` (`reason='test'`) antes de la carga histórica.

Criterio de selección (heurística, solo para localizar candidatos): nombre de cliente, producto o descripción con «prueba/test/demo/qa», o DNI con un solo dígito repetido. Resultado: 2 pedidos, ambos por la palabra «PRUEBA» (palabra completa) en el **nombre del producto**; ninguno por nombre de cliente, descripción ni DNI.

| Ref. (md5, 8) | Mes (Lima) | Hora Lima | Criterio | Cant. | Importe S/ | Líneas | Vendedor | Confirmación→ack | ID InkaClick | Mismo DNI en otros pedidos | Teléfono compartido con otros pedidos `acknowledged` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `c071235f` | 2026-10 | 19 | producto contiene «PRUEBA» | 1 | 1,00 | 0 (tradicional) | presente | 1203 s | sí | 0 | 2 |
| `821d22b1` | 2026-11 | 05 | producto contiene «PRUEBA» | 1 | 110,00 | 0 (tradicional) | presente | 322 s | sí | 0 | 2 |

Lectura (no concluyente): el producto de ambos no aparece en ningún otro pedido; en los dos el teléfono es el mismo que el de otros 2 pedidos `acknowledged`; uno cuesta S/ 1,00 (típico de prueba) y el otro S/ 110,00 (importe de venta plausible). Ambos llegaron a InkaClick. **Pendiente de confirmación humana** (por ejemplo, comprobar en InkaClick/ManyChat si corresponden a ventas reales). Hasta entonces se exportarían como cualquier pedido `acknowledged`.
