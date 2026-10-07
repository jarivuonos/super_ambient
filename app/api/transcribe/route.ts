import { getTranscription, jsonError, logError } from "@/lib/services";
import { TranscriptionUnavailable } from "@/lib/transcription/adapter";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(request: Request) {
  const tr = getTranscription();
  if (!tr.configured) return jsonError(tr.description, 503, { kind: "service-unavailable" });
  try {
    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof Blob) || audio.size === 0) return jsonError("Äänite puuttuu.", 400);
    if (audio.size > MAX_AUDIO_BYTES) return jsonError("Äänite on liian suuri.", 413);
    const transcript = await tr.transcribe(audio, { language: "fi", signal: request.signal });
    return Response.json({ transcript });
  } catch (e) {
    if (e instanceof TranscriptionUnavailable) return jsonError(e.message, 503, { kind: "service-unavailable" });
    logError("transcribe", e);
    return jsonError("Litterointi epäonnistui.", 500);
  }
}
