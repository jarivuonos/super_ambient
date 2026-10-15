import { executeSave, SaveRequestSchema } from "@/lib/workflow/save";
import { getCapabilitySummary, getEhr, jsonError, logError, writeBlocked } from "@/lib/services";

export async function POST(request: Request) {
  const parsed = SaveRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen tallennuspyyntö.", 400);
  if (!parsed.data.expectedSnapshot) return jsonError("Tallennus vaatii esikatsellun tilannevedoksen.", 400);
  const blocked = writeBlocked(parsed.data.sourceId);
  if (blocked) return blocked;
  try {
    const caps = await getCapabilitySummary(parsed.data.sourceId);
    // Validointi tehtiin esikatselussa; tilannevedoksen täsmäys takaa saman sisällön.
    const outcome = await executeSave(getEhr(parsed.data.sourceId), parsed.data, caps, { validate: false });
    return Response.json(outcome);
  } catch (e) {
    logError("save", e);
    return jsonError("Tallennuksen käsittely epäonnistui; tila voi olla tuntematon.", 500);
  }
}
