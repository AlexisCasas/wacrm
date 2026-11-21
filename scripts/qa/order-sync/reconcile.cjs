#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const STATUSES = new Set(['MATCH', 'WACRM_AHEAD', 'INKACLICK_AHEAD', 'CONFLICT', 'MISSING_IN_WACRM', 'MISSING_IN_INKACLICK', 'LEGACY'])
const DOMAIN_STATES = ['MATCH', 'WACRM_AHEAD', 'INKACLICK_AHEAD', 'CONFLICT', 'UNKNOWN']
const DOMAINS = ['customer', 'product', 'total', 'payments', 'balance', 'voucher', 'packing', 'shalom', 'tracking', 'messages']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function die(message) {
  process.stderr.write(`order-sync reconcile: ${message}\n`)
  process.exit(2)
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}

function bool(value) {
  return value === true
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
}

function covered(order, domain) {
  return order?.coverage?.[domain] !== false
}

function voucherKeys(order) {
  const rows = Array.isArray(order.vouchers) ? order.vouchers : []
  return rows
    .map((v) => `${normalizeText(v.shalom_number) ?? ''}|${normalizeText(v.shalom_code) ?? ''}`)
    .filter((v) => v !== '|')
}

function unique(values) {
  return [...new Set(values)].sort()
}

function messageSet(order) {
  const m = order.messages && typeof order.messages === 'object' ? order.messages : {}
  return ['packaging', 'shipment_voucher', 'arrival', 'reminder'].filter((k) => bool(m[k]))
}

function facts(order) {
  if (!order) return null
  return {
    customer: {
      name: bool(order.customer?.has_name),
      phone: bool(order.customer?.has_phone),
      dni: bool(order.customer?.has_dni),
      destination: bool(order.customer?.has_destination),
    },
    product: normalizeText(order.product_key),
    total: asNumber(order.total),
    paid: asNumber(order.paid),
    balance: asNumber(order.balance),
    vouchers: unique(voucherKeys(order)),
    packing: bool(order.packing_completed),
    shipment: order.shipment
      ? {
          key: `${normalizeText(order.shipment.tracking_number) ?? ''}|${normalizeText(order.shipment.tracking_code) ?? ''}`,
          status: normalizeText(order.shipment.status),
        }
      : null,
    messages: unique(messageSet(order)),
  }
}

function emptyValue(v) {
  if (v === null || v === undefined || v === false) return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.values(v).every(emptyValue)
  return false
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function compareDomain(a, b) {
  if (equal(a, b)) return 'MATCH'
  const ae = emptyValue(a)
  const be = emptyValue(b)
  if (!ae && be) return 'WACRM_AHEAD'
  if (ae && !be) return 'INKACLICK_AHEAD'
  return 'CONFLICT'
}

function compareSet(a, b) {
  const aa = new Set(Array.isArray(a) ? a : [])
  const bb = new Set(Array.isArray(b) ? b : [])
  if (aa.size === bb.size && [...aa].every((x) => bb.has(x))) return 'MATCH'
  const aSubset = [...aa].every((x) => bb.has(x))
  const bSubset = [...bb].every((x) => aa.has(x))
  if (bSubset && !aSubset) return 'WACRM_AHEAD'
  if (aSubset && !bSubset) return 'INKACLICK_AHEAD'
  return 'CONFLICT'
}

function compareCustomer(a, b) {
  const ak = Object.entries(a ?? {}).filter(([, v]) => v === true).map(([k]) => k)
  const bk = Object.entries(b ?? {}).filter(([, v]) => v === true).map(([k]) => k)
  return compareSet(ak, bk)
}

function comparePaid(wPaid, iPaid) {
  if (equal(wPaid, iPaid)) return 'MATCH'
  if ((wPaid ?? 0) === 0 && (iPaid ?? 0) > 0) return 'INKACLICK_AHEAD'
  if ((iPaid ?? 0) === 0 && (wPaid ?? 0) > 0) return 'WACRM_AHEAD'
  return 'CONFLICT'
}

function compareCovered(w, i, domain, fn) {
  if (!covered(w, domain) || !covered(i, domain)) return 'UNKNOWN'
  return fn()
}

function classify(w, i) {
  if (!w && i?.source !== 'wacrm') return { status: 'LEGACY', domains: {}, coverage_complete: false }
  if (!w) return { status: 'MISSING_IN_WACRM', domains: {}, coverage_complete: false }
  if (!i) return { status: 'MISSING_IN_INKACLICK', domains: {}, coverage_complete: false }

  const wf = facts(w)
  const inf = facts(i)
  const domains = {
    customer: compareCovered(w, i, 'customer', () => compareCustomer(wf.customer, inf.customer)),
    product: compareCovered(w, i, 'product', () => compareDomain(wf.product, inf.product)),
    total: compareCovered(w, i, 'total', () => compareDomain(wf.total, inf.total)),
    payments: compareCovered(w, i, 'payments', () => comparePaid(wf.paid, inf.paid)),
    balance: compareCovered(w, i, 'balance', () => compareDomain(wf.balance, inf.balance)),
    voucher: compareCovered(w, i, 'voucher', () => compareSet(wf.vouchers, inf.vouchers)),
    packing: compareCovered(w, i, 'packing', () => compareDomain(wf.packing, inf.packing)),
    shalom: compareCovered(w, i, 'shalom', () => compareDomain(wf.shipment?.key ?? null, inf.shipment?.key ?? null)),
    tracking: compareCovered(w, i, 'tracking', () => compareDomain(wf.shipment?.status ?? null, inf.shipment?.status ?? null)),
    messages: compareCovered(w, i, 'messages', () => compareSet(wf.messages, inf.messages)),
  }

  if (domains.total === 'MATCH' && domains.payments === 'INKACLICK_AHEAD' && domains.balance !== 'UNKNOWN' && !equal(wf.balance, inf.balance)) domains.balance = 'INKACLICK_AHEAD'
  if (domains.total === 'MATCH' && domains.payments === 'WACRM_AHEAD' && domains.balance !== 'UNKNOWN' && !equal(wf.balance, inf.balance)) domains.balance = 'WACRM_AHEAD'

  const states = new Set(Object.values(domains).filter((x) => x !== 'UNKNOWN'))
  let status = 'MATCH'
  if (states.has('CONFLICT') || (states.has('WACRM_AHEAD') && states.has('INKACLICK_AHEAD'))) status = 'CONFLICT'
  else if (states.has('WACRM_AHEAD')) status = 'WACRM_AHEAD'
  else if (states.has('INKACLICK_AHEAD')) status = 'INKACLICK_AHEAD'
  return { status, domains, coverage_complete: !Object.values(domains).includes('UNKNOWN') }
}

function indexByCanonical(rows, side) {
  const map = new Map()
  const invalid = []
  const duplicates = []
  for (const row of rows) {
    const id = row.canonical_order_id
    if (!id) {
      if (side === 'inkaclick' && row.source !== 'wacrm') continue
      invalid.push(row)
      continue
    }
    if (!UUID.test(id)) {
      invalid.push(row)
      continue
    }
    if (map.has(id)) duplicates.push(id)
    else map.set(id, row)
  }
  return { map, invalid, duplicates: unique(duplicates) }
}

function countDuplicateVouchers(rows) {
  let groups = 0
  let excessRows = 0
  let coveredOrders = 0
  for (const row of rows) {
    if (!covered(row, 'voucher')) continue
    coveredOrders += 1
    const keys = voucherKeys(row)
    const counts = new Map()
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
    for (const n of counts.values()) {
      if (n > 1) {
        groups += 1
        excessRows += n - 1
      }
    }
  }
  return { groups, excess_rows: excessRows, covered_orders: coveredOrders }
}

function reconcile(wacrmRows, inkaclickRows) {
  const w = indexByCanonical(wacrmRows, 'wacrm')
  const i = indexByCanonical(inkaclickRows, 'inkaclick')
  const ids = unique([...w.map.keys(), ...i.map.keys()])
  const orders = []

  for (const id of ids) {
    const wr = w.map.get(id) ?? null
    const ir = i.map.get(id) ?? null
    const result = classify(wr, ir)
    orders.push({
      canonical_order_id: id,
      legacy_inkaclick_id: ir?.legacy_inkaclick_id ?? null,
      status: result.status,
      domains: result.domains,
      coverage_complete: result.coverage_complete,
      held_not_delivered: wr?.delivery_status === 'held',
    })
  }

  for (const row of inkaclickRows) {
    if (!row.canonical_order_id && row.source !== 'wacrm') {
      orders.push({ canonical_order_id: null, legacy_inkaclick_id: row.legacy_inkaclick_id ?? null, status: 'LEGACY', domains: {}, coverage_complete: false, held_not_delivered: false })
    }
  }

  const summary = Object.fromEntries([...STATUSES].map((s) => [s, 0]))
  const domainSummary = Object.fromEntries(DOMAINS.map((d) => [d, Object.fromEntries(DOMAIN_STATES.map((s) => [s, 0]))]))
  let held = 0
  let incomplete = 0
  for (const o of orders) {
    summary[o.status] = (summary[o.status] ?? 0) + 1
    if (o.held_not_delivered) held += 1
    if (!o.coverage_complete && o.canonical_order_id) incomplete += 1
    for (const [domain, state] of Object.entries(o.domains)) domainSummary[domain][state] += 1
  }

  return {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    read_only: true,
    canonical_id: 'wacrm.order_confirmations.id',
    counts: {
      wacrm_snapshot: wacrmRows.length,
      inkaclick_snapshot: inkaclickRows.length,
      canonical_orders: ids.length,
      ...summary,
      INCOMPLETE_COVERAGE: incomplete,
      HELD_NOT_DELIVERED: held,
      INVALID_WACRM_IDS: w.invalid.length,
      INVALID_INKACLICK_IDS: i.invalid.length,
      DUPLICATE_WACRM_MAPPINGS: w.duplicates.length,
      DUPLICATE_INKACLICK_MAPPINGS: i.duplicates.length,
    },
    duplicate_vouchers: {
      wacrm: countDuplicateVouchers(wacrmRows),
      inkaclick: countDuplicateVouchers(inkaclickRows),
    },
    domain_summary: domainSummary,
    anomalies: {
      invalid_wacrm_ids: w.invalid.map((r) => r.canonical_order_id ?? null),
      invalid_inkaclick_ids: i.invalid.map((r) => r.canonical_order_id ?? null),
      duplicate_wacrm_mappings: w.duplicates,
      duplicate_inkaclick_mappings: i.duplicates,
    },
    orders,
  }
}

function loadSnapshot(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(raw)) die(`${file}: snapshot must be a JSON array`)
  return raw
}

function parseArgs(argv) {
  const args = {}
  for (let n = 0; n < argv.length; n += 1) {
    const k = argv[n]
    if (!['--wacrm', '--inkaclick', '--out'].includes(k)) die(`unknown argument ${k}`)
    const v = argv[++n]
    if (!v) die(`missing value for ${k}`)
    args[k.slice(2)] = v
  }
  if (!args.wacrm || !args.inkaclick) die('usage: reconcile.cjs --wacrm snapshot.json --inkaclick snapshot.json [--out report.json]')
  return args
}

function assertFileOnly(value) {
  if (/^[a-z]+:\/\//i.test(value) || value.includes('postgres://') || value.includes('postgresql://')) die('database/network URLs are forbidden; provide snapshot files only')
  const resolved = path.resolve(value)
  const st = fs.statSync(resolved)
  if (!st.isFile()) die(`${value}: not a regular file`)
  return resolved
}

function human(report) {
  const c = report.counts
  return [
    'SYNC-00 + SYNC-01 READ-ONLY RECONCILIATION',
    `canonical orders: ${c.canonical_orders}`,
    `MATCH=${c.MATCH} WACRM_AHEAD=${c.WACRM_AHEAD} INKACLICK_AHEAD=${c.INKACLICK_AHEAD} CONFLICT=${c.CONFLICT}`,
    `MISSING_IN_WACRM=${c.MISSING_IN_WACRM} MISSING_IN_INKACLICK=${c.MISSING_IN_INKACLICK} LEGACY=${c.LEGACY}`,
    `INCOMPLETE_COVERAGE=${c.INCOMPLETE_COVERAGE} HELD_NOT_DELIVERED=${c.HELD_NOT_DELIVERED}`,
    `duplicate voucher groups: WACRM=${report.duplicate_vouchers.wacrm.groups} InkaClick=${report.duplicate_vouchers.inkaclick.groups}`,
  ].join('\n')
}

if (require.main === module) {
  if (process.env.SYNC_RECONCILE_READ_ONLY !== '1') die('refusing to run: set SYNC_RECONCILE_READ_ONLY=1 explicitly')
  const args = parseArgs(process.argv.slice(2))
  const report = reconcile(loadSnapshot(assertFileOnly(args.wacrm)), loadSnapshot(assertFileOnly(args.inkaclick)))
  if (args.out) fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`${human(report)}\n`)
}

module.exports = { classify, reconcile, voucherKeys }
