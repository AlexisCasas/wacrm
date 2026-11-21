import { toErrorResponse } from '@/lib/auth/account'
import { listChatMedia } from '@/lib/orders/logistics/evidence'
import { authorize, respond } from '@/lib/orders/logistics/http'

// GET /api/orders/logistics/orders/[orderId]/chat-media   the media messages of the SAME conversation as the order (images / documents), newest
// first, flagged `available` when the file can be kept as evidence. Read with the caller's own client: the existing conversation access rules apply
// (flag + area + routing stage + RLS) on top of the logistics gate. Nothing is copied, moved or changed.
export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const auth = await authorize()
    if (!auth.ok) return auth.response
    const { orderId } = await params
    return respond(await listChatMedia(auth.ctx, orderId))
  } catch (error) {
    return toErrorResponse(error)
  }
}
