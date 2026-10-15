import { z } from "zod";
import { buildFixtureBundle } from "@/lib/fhir/fixtures";
import { SourceIdSchema } from "@/lib/fhir/sources";
import { getCapabilitySummary, getEhr, jsonError, logError, writeBlocked } from "@/lib/services";

// GET: esikatselu (ei verkkoliikennettä). POST: lähettää vain sovelluksen omat fixturet.
export async function GET() {
  const { items, bundle } = buildFixtureBundle();
  return Response.json({ items, bundle });
}

const Body = z.strictObject({ sourceId: SourceIdSchema });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return jsonError("Virheellinen pyyntö.", 400);
  const blocked = writeBlocked(parsed.data.sourceId);
  if (blocked) return blocked;
  try {
    const caps = await getCapabilitySummary(parsed.data.sourceId);
    if (!caps?.transaction) return jsonError("Palvelin ei tue transactionia tai kyvykkyyksiä ei voitu tarkistaa.", 409);
    const { bundle, items } = buildFixtureBundle();
    const tx = await getEhr(parsed.data.sourceId).transaction(bundle);
    if (tx.state !== "accepted") {
      return Response.json({ ok: false, state: tx.state, error: tx.error.message }, { status: 502 });
    }
    return Response.json({
      ok: true,
      entries: items.map((it, i) => ({ ...it, reference: tx.entries[i].reference, status: tx.entries[i].status, existing: tx.entries[i].existing })),
    });
  } catch (e) {
    logError("seed", e);
    return jsonError("Harjoitusaineiston luonti epäonnistui.", 500);
  }
}
