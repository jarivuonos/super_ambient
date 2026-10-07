import { z } from "zod";
import { getEhr, jsonError, logError } from "@/lib/services";

const Body = z.strictObject({ query: z.string().max(120), demoOnly: z.boolean() });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Virheellinen pyyntö.", 400);
  try {
    const res = await getEhr().searchPatients(parsed.data.query, parsed.data.demoOnly, request.signal);
    return Response.json(res);
  } catch (e) {
    logError("patients", e);
    return jsonError("Potilashaku epäonnistui.", 500);
  }
}
