import { getTranscription, jsonError, logError } from "@/lib/services";
import { TranscriptionUnavailable } from "@/lib/transcription/adapter";
import type { StageTimings } from "@/lib/transcription/gemini-client";

// Litterointi voi kestää minuutteja (Gemini ruuhkassa jopa yli 10 min); varataan enimmäisaika, jonka palvelu sallii.
export const maxDuration = 300;

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request) {
  const tr = getTranscription();
  const timing: { t?: StageTimings } = {};
  if (!tr.configured) return jsonError(tr.description, 503, { kind: "service-unavailable" });
  try {
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof Blob) || audio.size === 0) return jsonError("Äänite puuttuu.", 400);
    if (audio.size > MAX_AUDIO_BYTES) return jsonError("Äänite on liian suuri.", 413);
    const transcript = await tr.transcribe(audio, { language: "fi", signal: request.signal, onTimings: (t) => void (timing.t = t) });
    return Response.json({ transcript, timings: timing.t });
  } catch (e) {
    if (e instanceof TranscriptionUnavailable) return jsonError(e.message, 503, { kind: "service-unavailable", timings: timing.t });
    logError("transcribe", e);
    return jsonError("Litterointi epäonnistui.", 500);
  }
}
