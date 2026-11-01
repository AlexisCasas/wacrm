const BASE = 'http://gw:8000/functions/v1/wacrm-confirmed-orders'
const T = process.env.WACRM_TOKEN, SK = process.env.SERVICE_KEY
const uuid = () => crypto.randomUUID()
const mk = (ext, over = {}) => ({ source: 'wacrm', external_order_id: ext, fecha_hora: '2026-10-31T16:12:16-05:00', nombre_completo: 'Cliente Sintetico', dni: '12345678', telefono: '51900000011', producto: 'Producto prueba', cantidad_productos: 2, precio: '150.50', descripcion_pedido: 'Texto libre de prueba', agencia: 'Shalom', destino: 'Lima, Lima', vendedor: 'Vendedor Uno', estado_pedido: 'Pedido confirmado', departamento: 'Lima', ...over })
const call = async (method, url, { token = T, body, headers = {}, raw } = {}) => {
  const h = { ...headers }; if (token) h.authorization = `Bearer ${token}`
  if (body !== undefined || raw !== undefined) h['content-type'] = 'application/json'
  const r = await fetch(url, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) })
  let j = null; const txt = await r.text(); try { j = JSON.parse(txt) } catch {}
  return { s: r.status, j, txt }
}
const out = []; const rec = (id, name, ok, note = '') => { out.push({ id, name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name} ${note}`) }
const short = (x) => (x ? String(x).slice(0, 8) + '…' : x)

let r = await call('POST', BASE, { token: null, body: mk(uuid()) }); rec('H1', 'POST sin token -> 401', r.s === 401 && r.j?.code === 'unauthorized', `status=${r.s}`)
r = await call('POST', BASE, { token: 'incorrecto', body: mk(uuid()) }); rec('H2', 'POST token incorrecto -> 401', r.s === 401, `status=${r.s}`)
r = await call('POST', BASE, { token: SK, body: mk(uuid()) }); rec('H2b', 'Un JWT de service_role NO sirve como secreto del receptor -> 401', r.s === 401, `status=${r.s}`)
r = await call('GET', `${BASE}?external_order_id=${uuid()}`, { token: null }); rec('H2c', 'GET sin token -> 401', r.s === 401, `status=${r.s}`)
r = await call('POST', 'http://gw:8000/functions/v1/otra-funcion', { token: null, body: {} }); rec('H2d', 'Otra función sin JWT sigue protegida por verify_jwt -> 401 Invalid JWT', r.s === 401 && r.j?.msg === 'Invalid JWT', `status=${r.s}`)

const ext = uuid()
r = await call('POST', BASE, { body: mk(ext), headers: { 'idempotency-key': ext } }); const id1 = r.j?.id
rec('H3', 'POST válido -> 201 con id', r.s === 201 && !!id1, `status=${r.s} id=${short(id1)}`)
r = await call('POST', BASE, { body: mk(ext), headers: { 'idempotency-key': ext } })
rec('H4', 'POST repetido -> 200 y mismo id', r.s === 200 && r.j?.id === id1, `status=${r.s} same=${r.j?.id === id1}`)
r = await call('GET', `${BASE}?external_order_id=${ext}`); rec('H5', 'GET reconciliación -> mismo id', r.s === 200 && r.j?.id === id1, `status=${r.s}`)
r = await call('GET', `${BASE}?external_order_id=${uuid()}`); rec('H5b', 'GET de un id inexistente -> 404', r.s === 404, `status=${r.s}`)
r = await call('GET', `${BASE}?external_order_id=no-es-uuid`); rec('H5c', 'GET con id mal formado -> 400', r.s === 400, `status=${r.s}`)

const bad = [
  ['telefono sin 51', { telefono: '900000011' }, 'invalid_telefono'], ['precio 0', { precio: '0.00' }, 'invalid_precio'], ['precio con 3 decimales', { precio: '10.123' }, 'invalid_precio'],
  ['cantidad 0', { cantidad_productos: 0 }, 'invalid_cantidad'], ['source distinto', { source: 'manychat' }, 'invalid_source'], ['estado distinto', { estado_pedido: 'Pagado' }, 'invalid_estado_pedido'],
  ['fecha sin zona', { fecha_hora: '2026-10-31T16:12:16Z' }, 'invalid_fecha_hora'], ['vendedor vacío', { vendedor: ' ' }, 'missing_required_field'], ['destino faltante', { destino: undefined }, 'missing_required_field'],
  ['id no UUID', { external_order_id: 'x' }, 'invalid_external_order_id'],
]
let allBad = true
for (const [n, over, code] of bad) { r = await call('POST', BASE, { body: mk(uuid(), over) }); const ok = r.s === 422 && r.j?.code === code; allBad &&= ok; if (!ok) console.log(`  detalle ${n}: status=${r.s} code=${r.j?.code}`) }
rec('H6a', `${bad.length} payloads inválidos -> 422 con código`, allBad)
r = await call('POST', BASE, { raw: '{no json' }); rec('H6b', 'JSON inválido -> 400', r.s === 400, `status=${r.s}`)
r = await call('POST', BASE, { body: mk(ext), headers: { 'idempotency-key': uuid() } }); rec('H6c', 'Idempotency-Key distinto del cuerpo -> 400', r.s === 400, `status=${r.s}`)
r = await call('PUT', BASE, { body: {} }); rec('H6d', 'Método no permitido -> 405', r.s === 405, `status=${r.s}`)
const leak = (await call('POST', BASE, { body: mk(uuid(), { telefono: '1' }) })).txt
rec('H6e', 'Las respuestas de error no devuelven datos del cliente', !/Sintetico|12345678|51900000011|Vendedor/.test(leak))

const cext = uuid()
const rs = await Promise.all(Array.from({ length: 25 }, () => call('POST', BASE, { body: mk(cext, { telefono: '51900000012', dni: '87654321' }) })))
const created = rs.filter((x) => x.s === 201).length, replay = rs.filter((x) => x.s === 200).length, ids = new Set(rs.map((x) => x.j?.id))
rec('H7', 'Concurrencia x25 con el mismo id: 1 creado, 24 repetidos, mismo id, sin 5xx', created === 1 && replay === 24 && ids.size === 1, `201=${created} 200=${replay} otros=${25 - created - replay} ids=${ids.size}`)

const lext = uuid()
const ac = new AbortController(); const p = fetch(BASE, { method: 'POST', headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, body: JSON.stringify(mk(lext, { telefono: '51900000013', dni: '' })), signal: ac.signal }).catch(() => 'aborted')
ac.abort(); await p
await new Promise((res) => setTimeout(res, 1500))
const g = await call('GET', `${BASE}?external_order_id=${lext}`)
const again = await call('POST', BASE, { body: mk(lext, { telefono: '51900000013', dni: '' }) })
const g2 = await call('GET', `${BASE}?external_order_id=${lext}`)
rec('H8', 'Respuesta perdida: tras el reintento hay un único pedido y el GET coincide', (again.s === 200 || again.s === 201) && g2.s === 200 && g2.j?.id === again.j?.id, `antes_del_reintento=${g.s} reintento=${again.s}`)
console.log(JSON.stringify({ ext, cext, lext, total: out.length, fail: out.filter((o) => !o.ok).length }))
