/** The browser side of /api/audio-guide: one fetch wrapper that never throws, so every caller handles a failed call the same way. */

export type ApiResult = { status: number; body: Record<string, unknown> };

export async function api(method: string, url: string, body?: unknown): Promise<ApiResult> {
  try {
    const response = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { status: 0, body: {} };
  }
}
