import { z } from "zod";
import { getEhr, jsonError, logError } from "@/lib/services";

const Body = z.strictObject({ patientId: z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/) });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen pyyntö.", 400);
  try {
    return Response.json(await getEhr().searchEncounters(parsed.data.patientId, request.signal));
  } catch (e) {
    logError("encounters", e);
    return jsonError("Kontaktihaku epäonnistui.", 500);
  }
}
