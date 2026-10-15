import { connection } from "next/server";
import { getConfig } from "@/lib/config";
import { sessionFromRequest } from "@/lib/auth/session";
import { DEFAULT_SOURCE_ID, findSource } from "@/lib/fhir/sources";
import { checkCapabilities, getEhr, getLanguage, getTranscription, jsonError } from "@/lib/services";

export async function GET(request: Request) {
  await connection();
  const params = new URL(request.url).searchParams;
  const force = params.get("refresh") === "1";
  const sourceId = params.get("source") ?? DEFAULT_SOURCE_ID;
  const source = findSource(sourceId);
  if (!source) return jsonError("Tuntematon FHIR-lähde.", 400);
  const session = sessionFromRequest(request, sourceId);
  const { check, lastSuccess } = await checkCapabilities(sourceId, force);
  const cfg = getConfig();
  const lang = getLanguage();
  const tr = getTranscription();
  return Response.json({
    auth:
      source.auth.kind === "none"
        ? { required: false as const }
        : {
            required: true as const,
            configured: Boolean(process.env[source.auth.clientIdEnv]?.trim()),
            loggedIn: session !== null,
            expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
          },
    fhir: {
      adapter: getEhr(sourceId).name,
      baseUrl: getEhr(sourceId).baseUrl,
      check: check.ok
        ? { ok: true, checkedAt: check.checkedAt, summary: check.summary }
        : { ok: false, checkedAt: check.checkedAt, error: check.error },
      lastSuccessAt: lastSuccess?.at ?? null,
    },
    language: { name: lang.name, kind: lang.kind, description: lang.description, model: cfg.llm.model ?? null, capabilities: lang.capabilities },
    transcription: { name: tr.name, configured: tr.configured, description: tr.description, capabilities: tr.capabilities },
  });
}
