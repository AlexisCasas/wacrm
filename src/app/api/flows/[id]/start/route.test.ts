import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// POST /api/flows/[id]/start — the manual "Iniciar Flow" endpoint.
// This suite tests ONLY the route's own responsibilities: auth,
// request validation, account-scoped conversation resolution, the
// 24h service-window check, and mapping `startFlowManually`'s result
// to HTTP responses. `startFlowManually` itself is mocked — its own
// behavior is covered by src/lib/flows/manual-start.test.ts.

const ACCOUNT = "acct-1"

let callerRole: string = "agent"
let conversationRow: Record<string, unknown> | null = {
  id: "conv-1",
  account_id: ACCOUNT,
}
let lastCustomerMessage: Record<string, unknown> | null = {
  created_at: new Date().toISOString(),
}

function makeSupabaseMock() {
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ["select", "eq", "order", "limit"]) b[m] = vi.fn(chain)

    const terminal = () => {
      switch (table) {
        case "profiles":
          return { data: { account_id: ACCOUNT, account_role: callerRole }, error: null }
        case "accounts":
          return { data: { id: ACCOUNT, name: "Acme" }, error: null }
        case "conversations":
          return { data: conversationRow, error: null }
        case "messages":
          return { data: lastCustomerMessage, error: null }
        default:
          return { data: null, error: null }
      }
    }
    b.maybeSingle = vi.fn(() => Promise.resolve(terminal()))
    b.single = vi.fn(() => Promise.resolve(terminal()))
    b.then = (resolve: (v: unknown) => unknown) => resolve(terminal())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async (): Promise<{ data: { user: { id: string } | null }; error: null }> => ({
        data: { user: { id: "user-1" } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

const { startFlowManually } = vi.hoisted(() => ({
  startFlowManually: vi.fn(),
}))
vi.mock("@/lib/flows/engine", () => ({ startFlowManually }))

import { POST } from "./route"

function post(body: Record<string, unknown> = { conversation_id: "conv-1" }) {
  return POST(
    new Request("http://localhost/api/flows/flow-1/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "flow-1" }) },
  )
}

beforeEach(() => {
  callerRole = "agent"
  conversationRow = { id: "conv-1", account_id: ACCOUNT }
  lastCustomerMessage = { created_at: new Date().toISOString() }
  supabaseMock = makeSupabaseMock()
  startFlowManually.mockReset()
  startFlowManually.mockResolvedValue({
    outcome: "started",
    flow_run_id: "run-1",
    flow_id: "flow-1",
    flow_name: "Combo XTD",
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/flows/[id]/start — auth", () => {
  it("401s when there is no session", async () => {
    supabaseMock.auth.getUser = vi.fn(async () => ({ data: { user: null }, error: null }))
    const res = await post()
    expect(res.status).toBe(401)
    expect(startFlowManually).not.toHaveBeenCalled()
  })

  it("403s a viewer", async () => {
    callerRole = "viewer"
    const res = await post()
    expect(res.status).toBe(403)
    expect(startFlowManually).not.toHaveBeenCalled()
  })

  it("allows an agent through", async () => {
    const res = await post()
    expect(res.status).toBe(201)
  })
})

describe("POST /api/flows/[id]/start — validation", () => {
  it("400s when conversation_id is missing", async () => {
    const res = await post({})
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.code).toBe("missing_conversation_id")
    expect(startFlowManually).not.toHaveBeenCalled()
  })
})

describe("POST /api/flows/[id]/start — tenancy", () => {
  it("404s when the conversation does not exist in the caller's account", async () => {
    conversationRow = null
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(404)
    expect(json.code).toBe("conversation_not_found")
    expect(startFlowManually).not.toHaveBeenCalled()
  })

  it("404s when startFlowManually reports the flow does not exist / belongs to another account", async () => {
    startFlowManually.mockResolvedValue({ outcome: "flow_not_found" })
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(404)
    expect(json.code).toBe("flow_not_found")
  })

  it("409s when the flow is draft/archived (flow_not_active)", async () => {
    startFlowManually.mockResolvedValue({ outcome: "flow_not_active" })
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.code).toBe("flow_not_active")
  })

  it("409s with contact_blocked when the contact is blocked (P0 contact blocking)", async () => {
    startFlowManually.mockResolvedValue({ outcome: "contact_blocked" })
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.code).toBe("contact_blocked")
  })
})

// P1 bug #2 — the run was created and executed, but its first advance
// already ended in status='failed'. Must never look like the 201
// success response, and must never leak the internal end_reason /
// exception / Meta error that caused it.
describe("POST /api/flows/[id]/start — run failed immediately (P1 bug #2)", () => {
  it("409s with flow_failed_immediately and only the flow_run_id, nothing internal", async () => {
    startFlowManually.mockResolvedValue({
      outcome: "run_failed_immediately",
      flow_run_id: "run-1",
      flow_id: "flow-1",
      flow_name: "Combo XTD",
    })
    const res = await post()
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.code).toBe("flow_failed_immediately")
    expect(json.flow_run_id).toBe("run-1")
    expect(json.success).not.toBe(true)
    expect(json).not.toHaveProperty("end_reason")
    const raw = JSON.stringify(json)
    expect(raw).not.toContain("send_text_failed")
    expect(raw).not.toContain("contact not found")
  })
})

describe("POST /api/flows/[id]/start — 24h service window", () => {
  it("returns service_window_expired when there is no customer inbound message at all", async () => {
    lastCustomerMessage = null
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.code).toBe("service_window_expired")
    expect(startFlowManually).not.toHaveBeenCalled()
  })

  it("returns service_window_expired when the last inbound message is >=24h old", async () => {
    lastCustomerMessage = {
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    }
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.code).toBe("service_window_expired")
    expect(startFlowManually).not.toHaveBeenCalled()
  })

  it("proceeds when the last inbound message is under 24h old", async () => {
    lastCustomerMessage = {
      created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }
    const res = await post()
    expect(res.status).toBe(201)
    expect(startFlowManually).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/flows/[id]/start — active-run conflict", () => {
  it("409s with active_flow_exists and the existing flow's details", async () => {
    startFlowManually.mockResolvedValue({
      outcome: "active_flow_exists",
      active_flow_run_id: "run-existing",
      active_flow_id: "flow-existing",
      active_flow_name: "AMOLADORA TOTAL",
    })
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.code).toBe("active_flow_exists")
    expect(json.active_flow_run_id).toBe("run-existing")
    expect(json.active_flow_name).toBe("AMOLADORA TOTAL")
  })
})

describe("POST /api/flows/[id]/start — success", () => {
  it("responds with flow_run_id, flow_id, flow_name on success", async () => {
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json).toMatchObject({
      success: true,
      flow_run_id: "run-1",
      flow_id: "flow-1",
      flow_name: "Combo XTD",
    })
    expect(startFlowManually).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      initiatedByUserId: "user-1",
      flowId: "flow-1",
      conversationId: "conv-1",
    })
  })

  it("never accepts account_id from the request body", async () => {
    await post({ conversation_id: "conv-1", account_id: "attacker-account" })
    expect(startFlowManually).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT }),
    )
  })
})

describe("POST /api/flows/[id]/start — internal error", () => {
  it("500s without leaking the internal error message", async () => {
    startFlowManually.mockResolvedValue({ outcome: "error", message: "db exploded: secret detail" })
    const res = await post()
    const json = await res.json()
    expect(res.status).toBe(500)
    expect(json.code).toBe("internal_error")
    expect(JSON.stringify(json)).not.toContain("secret detail")
  })
})
