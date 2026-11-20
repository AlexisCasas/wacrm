/* LOCAL ONLY. Read-only smoke check of the REAL QA world (does not change any data): every QA user against the QA orders, through the real HTTP API. */
const L = require('./lib.cjs')
;(async () => {
  const st = L.readState()
  const sess = {}
  for (const [k, u] of Object.entries(st.users)) sess[k] = await L.login(u.email, st.password)
  const get = async (k, url) => { const r = await fetch(L.APP_URL + url, { headers: { cookie: sess[k].cookie } }); return r.status }
  const rows = []
  for (const k of Object.keys(st.users)) {
    const own = k === 'legacy' ? st.orders.L : k === 'externo' ? st.orders.D : st.orders.A
    rows.push({ user: k, confirmed_list: await get(k, '/api/orders/confirmed'), panel_own_order: await get(k, `/api/orders/logistics/orders/${own}`), panel_order_A: await get(k, `/api/orders/logistics/orders/${st.orders.A}`), summary: await get(k, `/api/orders/logistics/summary?ids=${st.orders.A}`), docs_list: await get(k, '/api/orders/logistics/documents') })
  }
  console.table(rows)
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
