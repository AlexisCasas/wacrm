// E2E router: same shape as the self-hosted stock router (HS256 verification, user workers). The hosted platform applies verify_jwt PER function
// (supabase/config.toml); here that is emulated with NO_VERIFY_JWT_FUNCTIONS, which mirrors `verify_jwt = false`.
import * as jose from 'jsr:@panva/jose@6'
const JWT_SECRET = Deno.env.get('JWT_SECRET')!
const NO_VERIFY = new Set((Deno.env.get('NO_VERIFY_JWT_FUNCTIONS') ?? '').split(',').filter(Boolean))
Deno.serve(async (req: Request) => {
  const service_name = new URL(req.url).pathname.split('/')[1]
  if (!service_name) return new Response(JSON.stringify({ msg: 'missing function name in request' }), { status: 400 })
  if (req.method !== 'OPTIONS' && !NO_VERIFY.has(service_name)) {
    try {
      const [bearer, token] = (req.headers.get('authorization') ?? '').split(' ')
      if (bearer !== 'Bearer') throw new Error('bad header')
      await jose.jwtVerify(token, new TextEncoder().encode(JWT_SECRET))
    } catch {
      return new Response(JSON.stringify({ msg: 'Invalid JWT' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    }
  }
  const envVars = Object.entries(Deno.env.toObject())
  try {
    const worker = await EdgeRuntime.userWorkers.create({ servicePath: `/home/deno/functions/${service_name}`, memoryLimitMb: 150, workerTimeoutMs: 60000, noModuleCache: false, importMapPath: null, envVars })
    return await worker.fetch(req)
  } catch (e) {
    return new Response(JSON.stringify({ msg: String(e) }), { status: 500 })
  }
})
