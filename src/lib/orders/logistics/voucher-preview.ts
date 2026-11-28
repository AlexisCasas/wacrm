import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { SupabaseClient } from '@supabase/supabase-js'

import { MAX_DOCUMENT_BYTES, ORDER_DOCS_BUCKET } from '@/lib/orders/logistics/constants'
import { fail, type ServiceResult } from '@/lib/orders/logistics/documents'
import { sniffMime } from '@/lib/orders/logistics/files'

const execFileAsync = promisify(execFile)
const META_MEDIA_TTL_SECONDS = 600
const MAX_RENDERED_IMAGE_BYTES = 5 * 1024 * 1024
const PDF_RENDER_TIMEOUT_MS = 15_000

function derivedPreviewPath(storagePath: string): string {
  return `${dirname(storagePath)}/derived/${basename(storagePath).replace(/\.[^.]+$/, '')}-whatsapp-page-1.jpg`
}

export async function voucherImageSignedUrl(
  admin: SupabaseClient,
  input: { storagePath: string; mimeType: string },
): Promise<ServiceResult<{ url: string; derived: boolean }>> {
  if (input.mimeType === 'image/jpeg' || input.mimeType === 'image/png') {
    const { data, error } = await admin.storage
      .from(ORDER_DOCS_BUCKET)
      .createSignedUrl(input.storagePath, META_MEDIA_TTL_SECONDS)
    if (error || !data?.signedUrl) return fail(502, 'storage_failed')
    return { ok: true, status: 200, body: { url: data.signedUrl, derived: false } }
  }

  // Meta template IMAGE headers support JPEG/PNG. A validated WEBP is not
  // forwarded as-is because Meta would reject it after the human clicks send.
  if (input.mimeType === 'image/webp') return fail(415, 'voucher_image_required')
  if (input.mimeType !== 'application/pdf') return fail(415, 'voucher_image_required')

  const { data: source, error: downloadError } = await admin.storage
    .from(ORDER_DOCS_BUCKET)
    .download(input.storagePath)
  if (downloadError || !source) return fail(502, 'storage_failed')

  const sourceBytes = new Uint8Array(await source.arrayBuffer())
  if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > MAX_DOCUMENT_BYTES) {
    return fail(413, 'file_too_large')
  }
  if (sniffMime(sourceBytes) !== 'application/pdf') return fail(415, 'voucher_image_required')

  const tempDir = await mkdtemp(join(tmpdir(), 'wacrm-voucher-'))
  const pdfPath = join(tempDir, 'voucher.pdf')
  const outputPrefix = join(tempDir, 'page')

  try {
    await writeFile(pdfPath, sourceBytes)
    try {
      await execFileAsync(
        'pdftoppm',
        ['-f', '1', '-singlefile', '-jpeg', '-r', '150', '-scale-to', '2000', pdfPath, outputPrefix],
        { timeout: PDF_RENDER_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      )
    } catch {
      return fail(502, 'voucher_render_failed')
    }

    let rendered: Uint8Array
    try {
      rendered = new Uint8Array(await readFile(`${outputPrefix}.jpg`))
    } catch {
      return fail(502, 'voucher_render_failed')
    }

    if (rendered.byteLength === 0 || rendered.byteLength > MAX_RENDERED_IMAGE_BYTES) {
      return fail(413, 'voucher_render_too_large')
    }
    if (sniffMime(rendered) !== 'image/jpeg') return fail(502, 'voucher_render_failed')

    const derivedPath = derivedPreviewPath(input.storagePath)
    const { error: uploadError } = await admin.storage
      .from(ORDER_DOCS_BUCKET)
      .upload(derivedPath, rendered, { contentType: 'image/jpeg', upsert: true })
    if (uploadError) return fail(502, 'storage_failed')

    const { data: signed, error: signError } = await admin.storage
      .from(ORDER_DOCS_BUCKET)
      .createSignedUrl(derivedPath, META_MEDIA_TTL_SECONDS)
    if (signError || !signed?.signedUrl) return fail(502, 'storage_failed')

    return { ok: true, status: 200, body: { url: signed.signedUrl, derived: true } }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
