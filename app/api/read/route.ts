import { z } from "zod";
import { belongsToPatient } from "@/lib/fhir/patient-guard";
import { getEhr, jsonError, logError } from "@/lib/services";

const Body = z.strictObject({
  patientId: z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/),
  references: z.array(z.string().regex(/^(Observation|Condition|DocumentReference)\/[A-Za-z0-9\-.]{1,64}$/)).max(50),
});

/** Lukee tallennetut resurssit takaisin. Palauttaa vain valitulle potilaalle kuuluvat. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen pyyntö.", 400);
  try {
    const ehr = getEhr();
    const results = await Promise.all(
      parsed.data.references.map(async (ref) => {
        const [rt, id] = ref.split("/");
        const r = await ehr.read(rt, id, request.signal);
        if (!r.ok) return { reference: ref, ok: false, error: r.error.message };
        if (!belongsToPatient(r.resource, parsed.data.patientId, ehr.baseUrl)) {
          return { reference: ref, ok: false, error: "Resurssi ei kuulu valitulle potilaalle." };
        }
        return { reference: ref, ok: true, resource: r.resource };
      }),
    );
    return Response.json({ results });
  } catch (e) {
    logError("read", e);
    return jsonError("Takaisinluku epäonnistui.", 500);
  }
}
