import { z } from "zod";
import { SourceIdSchema } from "@/lib/fhir/sources";
import { jsonError, logError, resolveEhr } from "@/lib/services";

const Body = z.strictObject({ patientId: z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/), sourceId: SourceIdSchema });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen pyyntö.", 400);
  const r = resolveEhr(parsed.data.sourceId, request);
  if (r.response) return r.response;
  try {
    return Response.json(await r.ehr.searchEncounters(parsed.data.patientId, request.signal));
  } catch (e) {
    logError("encounters", e);
    return jsonError("Kontaktihaku epäonnistui.", 500);
  }
}
