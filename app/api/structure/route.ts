import { z } from "zod";
import { LanguageRequestRejected, LanguageServiceUnavailable, parseWithRepair } from "@/lib/clinical/language-adapter";
import { StructuringOutputSchema, TranscriptSchema } from "@/lib/clinical/schemas";
import { transcriptVersion } from "@/lib/clinical/transcript";
import { getLanguage, jsonError, logError } from "@/lib/services";
import { finalizeStructuring } from "@/lib/workflow/review";

// Jev-luokittelu tekee yhden pyynnön lausetta kohti; varataan riittävästi aikaa pitkille litteraateille.
export const maxDuration = 60;

const Body = z.strictObject({
  transcript: TranscriptSchema,
  mode: z.enum(["adapter", "pasted"]),
  pasted: z.string().max(200_000).optional(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen pyyntö.", 400);
  const { transcript, mode, pasted } = parsed.data;
  if (transcriptVersion(transcript.segments) !== transcript.version) {
    return jsonError("Litteraattiversio ei vastaa sisältöä.", 409);
  }
  const lang = getLanguage();
  let raw: unknown;
  let source: string;
  let diagnostics: unknown = null;
  try {
    if (mode === "pasted") {
      // Käsin liitetty mallivastaus käsitellään samalla skeemalla ja tarkistuksilla.
      raw = pasted ?? "";
      source = "Käsin liitetty mallivastaus";
    } else {
      raw = await lang.structureTranscript(transcript, {
        signal: request.signal,
        onDiagnostics: (d) => {
          diagnostics = d;
        },
      });
      // Rakenteistuksen tekijä voi olla eri kuin adapterin nimi (esim. Jev-hybridissä mock-säännöt).
      const cap = lang.capabilities.structureTranscript;
      source = cap === "mock" ? "Mock (sääntöpohjainen)" : cap === "classified" ? `${lang.name} (luokittelu) + sovelluksen poiminta` : lang.name;
    }
  } catch (e) {
    if (e instanceof LanguageRequestRejected) return jsonError(e.message, 422, { kind: "limit" });
    if (e instanceof LanguageServiceUnavailable) return jsonError(e.message, 503, { kind: "service-unavailable" });
    logError("structure", e);
    return jsonError("Rakenteistaminen epäonnistui.", 500);
  }
  const validated = await parseWithRepair(raw, StructuringOutputSchema, mode === "adapter" ? lang.repair?.bind(lang) : undefined, 1);
  if (!validated.ok) return jsonError(`Vastaus ei vastannut skeemaa: ${validated.error}`, 422, { kind: "schema" });
  const result = finalizeStructuring(validated.data, transcript);
  if (!result.ok) return jsonError(result.error ?? "Vastaus hylättiin.", 422, { kind: "schema" });
  return Response.json({
    source,
    sourceKind: mode === "pasted" ? "pasted" : lang.capabilities.structureTranscript,
    transcriptVersion: transcript.version,
    note: result.note,
    proposals: result.proposals,
    warnings: result.warnings,
    diagnostics,
  });
}
