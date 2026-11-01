import http from 'node:http'
const T = process.env.WACRM_TOKEN
const ext = crypto.randomUUID()
const body = JSON.stringify({ source: 'wacrm', external_order_id: ext, fecha_hora: '2026-10-31T16:30:00-05:00', nombre_completo: 'Cliente Perdido', dni: '', telefono: '51900000014', producto: 'Producto prueba', cantidad_productos: 1, precio: '99.00', descripcion_pedido: '', agencia: 'Shalom', destino: 'Cusco, Cusco', vendedor: 'Vendedor Dos', estado_pedido: 'Pedido confirmado', departamento: '' })
const url = 'http://gw:8000/functions/v1/wacrm-confirmed-orders'
const req = http.request(url, { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } })
req.on('error', () => {}); req.write(body); req.end()
await new Promise((r) => setTimeout(r, 120)); req.destroy() // the response is never read: "lost"
await new Promise((r) => setTimeout(r, 3000))
const get = async () => fetch(`${url}?external_order_id=${ext}`, { headers: { authorization: `Bearer ${T}` } })
const g = await get(); const gj = await g.json().catch(() => ({}))
const rp = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body }); const rj = await rp.json()
console.log(`H8b respuesta perdida tras procesar: GET=${g.status} reintento=${rp.status} mismo_id=${gj.id === rj.id}`)
console.log(g.status === 200 && rp.status === 200 && gj.id === rj.id ? 'PASS H8b' : 'FAIL H8b')
