import { handleAttachmentRequest } from "@/lib/g2b/attachment-download";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  return handleAttachmentRequest(request, (await context.params).key);
}
