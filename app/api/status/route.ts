import { connection } from "next/server";
import { getConfig } from "@/lib/config";
import { checkCapabilities, getEhr, getLanguage, getTranscription } from "@/lib/services";

export async function GET(request: Request) {
  await connection();
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  const { check, lastSuccess } = await checkCapabilities(force);
  const cfg = getConfig();
  const lang = getLanguage();
  const tr = getTranscription();
  return Response.json({
    fhir: {
      adapter: getEhr().name,
      baseUrl: getEhr().baseUrl,
      check: check.ok
        ? { ok: true, checkedAt: check.checkedAt, summary: check.summary }
        : { ok: false, checkedAt: check.checkedAt, error: check.error },
      lastSuccessAt: lastSuccess?.at ?? null,
    },
    language: { name: lang.name, kind: lang.kind, description: lang.description, model: cfg.llm.model ?? null, capabilities: lang.capabilities },
    transcription: { name: tr.name, configured: tr.configured, description: tr.description, capabilities: tr.capabilities },
  });
}
