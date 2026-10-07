import { z } from "zod";
import { runAsk } from "@/lib/clinical/ask";
import { getEhr, getLanguage, jsonError, logError } from "@/lib/services";

const Id = z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/);
const Body = z.strictObject({ question: z.string().min(1).max(500), patientId: Id, encounterId: Id.nullable() });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen pyyntö.", 400);
  try {
    const res = await runAsk({
      question: parsed.data.question,
      patientId: parsed.data.patientId,
      encounterId: parsed.data.encounterId ?? undefined,
      today: new Date().toISOString().slice(0, 10),
      language: getLanguage(),
      ehr: getEhr(),
      signal: request.signal,
    });
    return Response.json({ ...res, patientId: parsed.data.patientId, encounterId: parsed.data.encounterId });
  } catch (e) {
    logError("ask", e);
    return jsonError("Kysymyksen käsittely epäonnistui.", 500);
  }
}
