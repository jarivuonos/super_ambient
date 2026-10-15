import { z } from "zod";
import { runAsk } from "@/lib/clinical/ask";
import { MockLanguageAdapter } from "@/lib/clinical/language-adapter";
import { SourceIdSchema } from "@/lib/fhir/sources";
import { getLanguage, jsonError, logError, resolveEhr } from "@/lib/services";

const Id = z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/);
const Body = z.strictObject({
  question: z.string().min(1).max(500),
  patientId: Id,
  encounterId: Id.nullable(),
  sourceId: SourceIdSchema,
  /** "mock": käyttäjä valitsi sääntöpohjaisen tulkinnan, kun mallipalvelu ei vastannut. */
  interpreter: z.enum(["configured", "mock"]).optional(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen pyyntö.", 400);
  const r = resolveEhr(parsed.data.sourceId, request);
  if (r.response) return r.response;
  try {
    const res = await runAsk({
      question: parsed.data.question,
      patientId: parsed.data.patientId,
      encounterId: parsed.data.encounterId ?? undefined,
      today: new Date().toISOString().slice(0, 10),
      language: parsed.data.interpreter === "mock" ? new MockLanguageAdapter() : getLanguage(),
      ehr: r.ehr,
      signal: request.signal,
    });
    if (parsed.data.interpreter === "mock") res.notes.push("Kysymys tulkittiin mock-säännöillä käyttäjän pyynnöstä (ei kielimallia).");
    return Response.json({ ...res, patientId: parsed.data.patientId, encounterId: parsed.data.encounterId });
  } catch (e) {
    logError("ask", e);
    return jsonError("Kysymyksen käsittely epäonnistui.", 500);
  }
}
