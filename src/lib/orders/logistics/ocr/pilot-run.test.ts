// @vitest-environment node
/**
 * CONTROLLED OCR PILOT RUNNER (manual, offline). SKIPPED unless ORDER_OCR_PILOT_DIR is set, so it never runs in CI or in the normal suite and never calls any provider by itself.
 *
 * It reads voucher files from a LOCAL folder OUTSIDE the repository, sends each ONE file to the configured provider (the same code production would use), scores the result
 * against a manual ground truth and writes `report.json` into that same folder. Nothing is written to the database, nothing is validated, nothing is sent anywhere else.
 *
 *   ORDER_OCR_PILOT_DIR=D:\ocr-pilot ORDER_OCR_PROVIDER=gemini ORDER_OCR_API_KEY=... ORDER_OCR_MODEL=<model A> npx vitest run src/lib/orders/logistics/ocr/pilot-run.test.ts
 *
 * A/B comparison on the SAME sample: ORDER_OCR_PILOT_MODELS="<model A>,<model B>" (each model is run over every file; the report has one run per model and a side-by-side summary).
 * Cost needs token usage; when the provider omits it the voucher is reported as usage_unavailable (not a failure, nothing is estimated). Optional cost: ORDER_OCR_PILOT_PRICE_IN / ORDER_OCR_PILOT_PRICE_OUT = USD per 1M tokens (from the provider's price list) when the provider reports token usage.
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
  it('runs every voucher once per model, scores it and writes report.json', async () => {
    const dir = DIR as string
    const models = (process.env.ORDER_OCR_PILOT_MODELS ?? process.env.ORDER_OCR_MODEL ?? '').split(',').map((m) => m.trim()).filter(Boolean)
    expect(models.length).toBeGreaterThan(0)
    const priceIn = Number.parseFloat(process.env.ORDER_OCR_PILOT_PRICE_IN ?? '')
    const priceOut = Number.parseFloat(process.env.ORDER_OCR_PILOT_PRICE_OUT ?? '')
    const truthFile = join(dir, 'truth.json')
    expect(existsSync(truthFile)).toBe(true)
    const truth = JSON.parse(readFileSync(truthFile, 'utf8')) as Record<string, { truth: PilotRecord['truth']; trueOrder?: string | null }>
    const files = readdirSync(dir).filter((f) => f !== 'truth.json' && f !== 'report.json').sort()

    const runs = []
    for (const model of models) {
      const provider = resolveOcrProvider({ ...process.env, ORDER_OCR_MODEL: model })
      expect(provider.name).not.toBe('not_configured') // refuse to "run" a pilot against nothing
      const records: PilotRecord[] = []
      const perFile: Array<{ file: string; errorCode: string | null; ms: number; usage?: 'usage_unavailable' }> = []
      for (const file of files) {
        const bytes = new Uint8Array(readFileSync(join(dir, file)))
        const mimeType = sniffMime(bytes)
        const expected = truth[file]
        if (!mimeType || !expected) continue
        const started = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS)
        try {
          const raw = await provider.extract({ bytes, mimeType, signal: controller.signal })
          const normalized = normalizeOcrOutput(raw)
          const ms = Date.now() - started
          const ocr: NonNullable<PilotRecord['ocr']> = {}
          for (const f of PILOT_FIELDS) if (normalized.fields[f]) ocr[f] = normalized.fields[f]
          const costUsd = raw.usage && Number.isFinite(priceIn) && Number.isFinite(priceOut) ? (raw.usage.inputTokens * priceIn + raw.usage.outputTokens * priceOut) / 1_000_000 : undefined
          records.push({ truth: expected.truth, ocr, ms, costUsd, trueOrder: expected.trueOrder ?? undefined })
          perFile.push({ file, errorCode: null, ms, ...(raw.usage ? {} : { usage: 'usage_unavailable' as const }) })
        } catch (error) {
          const code = error instanceof VoucherOcrError ? error.code : controller.signal.aborted ? 'ocr_timeout' : 'ocr_provider_error'
          const ms = Date.now() - started
          records.push({ truth: expected.truth, errorCode: code, ms, trueOrder: expected.trueOrder ?? undefined })
          perFile.push({ file, errorCode: code, ms })
        } finally {
          clearTimeout(timer)
        }
      }
      runs.push({ model, provider: provider.name, report: scorePilot(records), sweep: sweepThresholds(records), perFile })
    }
    // Side by side: the numbers that decide between models. The report holds METRICS and error codes only: no extracted value, no name, no DNI.
    const comparison = runs.map((r) => ({
      model: r.model,
      failed: r.report.failed,
      cleanRate: r.report.cleanRate,
      needReviewRate: r.report.needReviewRate,
      meanMs: r.report.meanMs,
      costPerVoucherUsd: r.report.costPerVoucherUsd,
      accuracy: Object.fromEntries(PILOT_FIELDS.map((f) => [f, r.report.fields[f].accuracy])),
      falsePositives: PILOT_FIELDS.reduce((n, f) => n + r.report.fields[f].falsePositives, 0),
    }))
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ comparison, runs }, null, 2))
    expect(runs.length).toBe(models.length)
  }, 3_600_000)
})
