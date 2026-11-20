// @vitest-environment node
/**
 * CONTROLLED OCR PILOT RUNNER (manual, offline). SKIPPED unless ORDER_OCR_PILOT_DIR is set, so it never runs in CI or in the normal suite and never calls any provider by itself.
 *
 * It reads voucher files from a LOCAL folder OUTSIDE the repository, sends each ONE file to the configured provider (the same code production would use), scores the result
 * against a manual ground truth and writes `report.json` into that same folder. Nothing is written to the database, nothing is validated, nothing is sent anywhere else.
 *
 *   ORDER_OCR_PILOT_DIR=D:\ocr-pilot ORDER_OCR_PROVIDER=vision_llm ORDER_OCR_API_KEY=... ORDER_OCR_MODEL=... npx vitest run src/lib/orders/logistics/ocr/pilot-run.test.ts
 *
 * Folder layout: the voucher files + `truth.json` = { "<file name>": { "truth": { "dni": "...", ... }, "trueOrder": "<any id>" } }. See docs/operations/P0-OCR-PILOT-PLAN.md.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { OCR_TIMEOUT_MS } from '@/lib/orders/logistics/constants'
import { sniffMime } from '@/lib/orders/logistics/files'
import { normalizeOcrOutput } from '@/lib/orders/logistics/ocr/normalize-result'
import { PILOT_FIELDS, scorePilot, sweepThresholds, type PilotRecord } from '@/lib/orders/logistics/ocr/pilot-metrics'
import { resolveOcrProvider } from '@/lib/orders/logistics/ocr/providers'
import { VoucherOcrError } from '@/lib/orders/logistics/ocr/types'

const DIR = process.env.ORDER_OCR_PILOT_DIR

describe.skipIf(!DIR)('OCR pilot (manual, local files only)', () => {
  it('runs every voucher once, scores it and writes report.json', async () => {
    const dir = DIR as string
    const provider = resolveOcrProvider()
    expect(provider.name).not.toBe('not_configured') // refuse to "run" a pilot against nothing
    const truthFile = join(dir, 'truth.json')
    expect(existsSync(truthFile)).toBe(true)
    const truth = JSON.parse(readFileSync(truthFile, 'utf8')) as Record<string, { truth: PilotRecord['truth']; trueOrder?: string | null }>

    const records: PilotRecord[] = []
    const perFile: Array<{ file: string; errorCode: string | null; ms: number }> = []
    for (const file of readdirSync(dir).filter((f) => f !== 'truth.json' && f !== 'report.json').sort()) {
      const bytes = new Uint8Array(readFileSync(join(dir, file)))
      const mimeType = sniffMime(bytes)
      const expected = truth[file]
      if (!mimeType || !expected) continue
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS)
      try {
        const normalized = normalizeOcrOutput(await provider.extract({ bytes, mimeType, signal: controller.signal }))
        const ms = Date.now() - started
        const ocr: NonNullable<PilotRecord['ocr']> = {}
        for (const f of PILOT_FIELDS) if (normalized.fields[f]) ocr[f] = normalized.fields[f]
        records.push({ truth: expected.truth, ocr, ms, trueOrder: expected.trueOrder ?? undefined })
        perFile.push({ file, errorCode: null, ms })
      } catch (error) {
        const code = error instanceof VoucherOcrError ? error.code : controller.signal.aborted ? 'ocr_timeout' : 'ocr_provider_error'
        const ms = Date.now() - started
        records.push({ truth: expected.truth, errorCode: code, ms, trueOrder: expected.trueOrder ?? undefined })
        perFile.push({ file, errorCode: code, ms })
      } finally {
        clearTimeout(timer)
      }
    }
    // The report holds METRICS and error codes only: no extracted value, no name, no DNI.
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ provider: provider.name, report: scorePilot(records), sweep: sweepThresholds(records), perFile }, null, 2))
    expect(records.length).toBeGreaterThan(0)
  }, 3_600_000)
})
