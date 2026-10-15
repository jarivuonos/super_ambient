import { z } from "zod";
import { SourceIdSchema } from "@/lib/fhir/sources";
import { jsonError, logError, resolveEhr } from "@/lib/services";

const Body = z.strictObject({ query: z.string().max(120), demoOnly: z.boolean(), sourceId: SourceIdSchema });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen pyyntö.", 400);
  const r = resolveEhr(parsed.data.sourceId, request);
  if (r.response) return r.response;
  try {
    const res = await r.ehr.searchPatients(parsed.data.query, parsed.data.demoOnly, request.signal);
    return Response.json(res);
  } catch (e) {
    logError("patients", e);
    return jsonError("Potilashaku epäonnistui.", 500);
  }
}
