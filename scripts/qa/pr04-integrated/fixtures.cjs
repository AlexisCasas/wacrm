/* LOCAL ONLY. Generates the known QA files into C:\WACRM-LOCAL-QA\fixtures (vouchers as PDF, chat images as PNG). Deterministic names, distinct bytes per file.
 * NOTE: the local FAKE OCR provider returns the SAME values for every file (see DEFAULT_FAKE_FIELDS); the text printed in each PDF is only a visual aid. */
const { createRequire } = require('node:module')
const { REPO, QA_DIR, fs, path } = require('./lib.cjs')
const sharp = createRequire(path.join(REPO, 'package.json'))('sharp')

const DIR = path.join(QA_DIR, 'fixtures')
const esc = (s) => s.replace(/[\\()]/g, '\\$&')

/** A minimal, valid one-page PDF with plain text lines (Helvetica). */
function pdf(lines) {
  const content = ['BT /F1 18 Tf 60 760 Td 24 TL', ...lines.map((l, i) => (i === 0 ? `(${esc(l)}) Tj` : `T* (${esc(l)}) Tj`)), 'ET'].join('\n')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const voucher = (title, extra) => pdf(['COMPROBANTE DE PAGO (QA LOCAL - SINTETICO)', title, '', ...extra, '', 'Archivo de prueba. No es un documento real.'])

async function png(label, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="${color}"/><text x="32" y="150" font-size="44" font-family="Arial" fill="#fff" font-weight="bold">${label[0]}</text><text x="32" y="215" font-size="28" font-family="Arial" fill="#fff">${label[1]}</text><text x="32" y="265" font-size="22" font-family="Arial" fill="#fff">${label[2]}</text></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

async function generate() {
  fs.mkdirSync(DIR, { recursive: true })
  const files = {}
  const put = (name, buf) => {
    fs.writeFileSync(path.join(DIR, name), buf)
    files[name] = path.join(DIR, name)
  }
  // Direct-upload vouchers (one per order, plus a spare of each to test a replacement version)
  put('voucher-pedidoA.pdf', voucher('Pedido A (1 producto)', ['Cliente: Cliente Prueba', 'Monto: S/ 10.00']))
  put('voucher-pedidoA-repuesto.pdf', voucher('Pedido A (repuesto)', ['Cliente: Cliente Prueba', 'Monto: S/ 10.00', 'Copia 2']))
  put('voucher-pedidoB.pdf', voucher('Pedido B (multiproducto)', ['Cliente: Ana Multi', 'Monto: S/ 20.00']))
  put('voucher-pedidoE.pdf', voucher('Pedido E (listo para embalar)', ['Cliente: Cliente Embalaje', 'Monto: S/ 15.00']))
  // Bulk upload: 3 distinct files per case (the local fake OCR reads the same fields from every file; the scenario changes WHICH orders can match)
  for (const [code, label] of [['A-seguro', 'CASO A (match seguro)'], ['B-ambiguo', 'CASO B (match ambiguo)'], ['C-sinmatch', 'CASO C (sin match)']]) {
    for (const n of [1, 2, 3]) put(`bulk-caso-${code}-${n}.pdf`, voucher(`${label} - archivo ${n}`, ['DNI: 12345678', 'Celular: 51900000001', 'Monto: S/ 10.00', `Ref ${code}-${n}`]))
  }
  // Chat images (evidence)
  put('media-A-correcta.png', await png(['MEDIA A', 'Conversacion CORRECTA', 'seleccionable'], '#0f766e'))
  put('media-A2-correcta.png', await png(['MEDIA A2', 'Conversacion CORRECTA', 'seleccionable'], '#15803d'))
  put('media-B-otra-conversacion.png', await png(['MEDIA B', 'OTRA conversacion', 'debe rechazarse'], '#b45309'))
  put('media-C-otra-cuenta.png', await png(['MEDIA C', 'OTRA cuenta', 'debe rechazarse'], '#b91c1c'))
  return { dir: DIR, files }
}

module.exports = { generate, DIR }
if (require.main === module) generate().then((r) => console.log(Object.keys(r.files).length, 'files in', r.dir))
