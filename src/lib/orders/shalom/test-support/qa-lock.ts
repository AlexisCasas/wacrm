// The PR-05 real-stack suites share GLOBAL database state on purpose: the poller claims every due shipment, the credentials breaker is global and the
// alert clock looks at every shipment. Vitest runs files in parallel, so those files take this cross-process lock (a lock file; a crashed holder is
// stolen after STALE_MS) and run one at a time. Test support only: nothing in the product uses it.
import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOCK = join(tmpdir(), 'wacrm-pr05-qa.lock')
const STALE_MS = 10 * 60_000

export async function acquireQaLock(timeoutMs = 8 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(LOCK, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) unlinkSync(LOCK)
      } catch {
        // someone else just released / stole it: retry
      }
      if (Date.now() > deadline) throw new Error('could not acquire the PR-05 QA lock')
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

export function releaseQaLock(): void {
  try {
    unlinkSync(LOCK)
  } catch {
    // already gone
  }
}
