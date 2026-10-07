import { checkServerContext, prepareSave, SaveRequestSchema } from "@/lib/workflow/save";
import { getCapabilitySummary, getEhr, jsonError, logError } from "@/lib/services";

export async function POST(request: Request) {
  const parsed = SaveRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen tallennuspyyntö.", 400);
  try {
    const prepared = prepareSave(parsed.data);
    if (!prepared.ok) return Response.json({ ok: false, errors: prepared.errors });
    const ehr = getEhr();
    const caps = await getCapabilitySummary();
    const ctxErrors = await checkServerContext(ehr, parsed.data, prepared.resources!.map((r) => r.resourceType), caps, request.signal);
    const validation = [];
    for (let i = 0; i < prepared.resources!.length; i++) {
      validation.push({ key: prepared.map![i].key, result: await ehr.validate(prepared.resources![i], request.signal) });
    }
    return Response.json({
      ok: ctxErrors.length === 0 && validation.every((v) => v.result.ok || v.result.unavailable),
      errors: ctxErrors,
      snapshot: prepared.snapshot,
      bundle: prepared.bundle,
      map: prepared.map,
      validation,
    });
  } catch (e) {
    logError("save/preview", e);
    return jsonError("Esikatselu epäonnistui.", 500);
  }
}
