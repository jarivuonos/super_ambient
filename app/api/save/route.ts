import { executeSave, SaveRequestSchema } from "@/lib/workflow/save";
import { getCapabilitySummary, getEhr, jsonError, logError } from "@/lib/services";

export async function POST(request: Request) {
  const parsed = SaveRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen tallennuspyyntö.", 400);
  if (!parsed.data.expectedSnapshot) return jsonError("Tallennus vaatii esikatsellun tilannevedoksen.", 400);
  try {
    const caps = await getCapabilitySummary();
    // Validointi tehtiin esikatselussa; tilannevedoksen täsmäys takaa saman sisällön.
    const outcome = await executeSave(getEhr(), parsed.data, caps, { validate: false });
    return Response.json(outcome);
  } catch (e) {
    logError("save", e);
    return jsonError("Tallennuksen käsittely epäonnistui; tila voi olla tuntematon.", 500);
  }
}
