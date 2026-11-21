import { describe, expect, it } from 'vitest'

import { buildDocumentPath, isAllowedMime, isUuid, safeFileName, sha256Hex, sniffMime } from '@/lib/orders/logistics/files'

const bytes = (...n: number[]) => Uint8Array.from(n)
const pad = (head: number[], length = 64) => Uint8Array.from([...head, ...new Array(Math.max(0, length - head.length)).fill(0)])

describe('sniffMime (the bytes decide, never the declared type)', () => {
  it('recognizes JPEG, PNG, WEBP and PDF', () => {
    expect(sniffMime(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffMime(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffMime(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0]))).toBe('image/webp')
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7\n...'))).toBe('application/pdf')
  })

  it('accepts a PDF whose header is preceded by a little junk, but not one that only mentions %PDF- late', () => {
    expect(sniffMime(new TextEncoder().encode('\n\n  %PDF-1.4'))).toBe('application/pdf')
    expect(sniffMime(new TextEncoder().encode('x'.repeat(2000) + '%PDF-1.4'))).toBeNull()
  })

  it('rejects everything else (executables, html, svg, zip, empty, RIFF that is not WEBP)', () => {
    expect(sniffMime(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull()
    expect(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull()
    expect(sniffMime(pad([0x4d, 0x5a]))).toBeNull() // MZ (exe)
    expect(sniffMime(pad([0x50, 0x4b, 0x03, 0x04]))).toBeNull() // zip
    expect(sniffMime(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull() // RIFF....WAVE
    expect(sniffMime(bytes())).toBeNull()
  })

  it('isAllowedMime only admits the four types', () => {
    expect(isAllowedMime('application/pdf')).toBe(true)
    expect(isAllowedMime('image/gif')).toBe(false)
    expect(isAllowedMime(null)).toBe(false)
  })
})

describe('sha256Hex', () => {
  it('is the standard lowercase hex digest', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('safeFileName', () => {
  it('strips paths, accents and unsafe characters and takes the extension from the SNIFFED type', () => {
    expect(safeFileName('C:\\Users\\x\\Comprobante Ñandú (1).pdf', 'application/pdf')).toBe('Comprobante_Nandu_1_.pdf')
    expect(safeFileName('../../etc/passwd', 'image/png')).toBe('passwd.png')
    expect(safeFileName('foto.exe', 'image/jpeg')).toBe('foto.jpg')
  })

  it('never returns an empty or hidden name and caps the length', () => {
    expect(safeFileName('', 'application/pdf')).toBe('documento.pdf')
    expect(safeFileName('...', 'image/webp')).toBe('documento.webp')
    expect(safeFileName('.hidden', 'image/png')).toBe('hidden.png')
    expect(safeFileName('a'.repeat(300) + '.pdf', 'application/pdf').length).toBeLessThanOrEqual(75)
  })
})

describe('buildDocumentPath', () => {
  const accountId = '11111111-1111-4111-8111-111111111111'
  const orderId = '22222222-2222-4222-8222-222222222222'
  const documentId = '33333333-3333-4333-8333-333333333333'

  it('is account-scoped and order-scoped', () => {
    expect(buildDocumentPath({ accountId, orderId, folder: 'vouchers', documentId, fileName: 'v.pdf' })).toBe(
      `account-${accountId}/orders/${orderId}/vouchers/${documentId}/v.pdf`,
    )
    expect(buildDocumentPath({ accountId, orderId, folder: 'evidence', documentId, fileName: 'e.jpg' })).toBe(`account-${accountId}/orders/${orderId}/evidence/${documentId}/e.jpg`)
  })

  it('bulk vouchers (no order yet) live under "unassigned" but still under the account prefix', () => {
    const path = buildDocumentPath({ accountId, orderId: null, folder: 'vouchers', documentId, fileName: 'v.pdf' })
    expect(path).toBe(`account-${accountId}/orders/unassigned/vouchers/${documentId}/v.pdf`)
    expect(path.startsWith(`account-${accountId}/`)).toBe(true)
  })
})

describe('isUuid', () => {
  it('accepts uuids only', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isUuid('nope')).toBe(false)
    expect(isUuid(undefined)).toBe(false)
  })
})
