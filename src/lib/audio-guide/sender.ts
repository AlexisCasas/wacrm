/** The real sender of the sequencer: the EXISTING Flow media transport with `voice: true` (no second implementation). */
import { engineSendMedia } from "@/lib/flows/meta-send";
import type { SendContext } from "./sequencer";

export async function sendVoiceNoteViaEngine(args: SendContext & { link: string }): Promise<{ whatsappMessageId: string }> {
  const { whatsapp_message_id } = await engineSendMedia({
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    // Names the originating run so a BSUID contact's per-send authorization (`bsuid_flow_send_check`) can be evaluated. Never bypasses
    // resolveContactTarget: engineSendMedia is the only transport.
    flowRunId: args.flowRunId,
    kind: "audio",
    link: args.link,
    voice: true,
  });
  return { whatsappMessageId: whatsapp_message_id };
}
