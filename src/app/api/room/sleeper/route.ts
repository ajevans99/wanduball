import { z } from "zod";
import { failure, HttpError, json, readJson } from "@/lib/server/http";
import { authenticate } from "@/lib/server/supabase";

export const runtime = "nodejs";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), roomId: z.uuid() }).strict(),
  z.object({ action: z.literal("apply"), roomId: z.uuid(), assignmentId: z.string().min(1).max(200) }).strict(),
  ...(["cleanup-preview", "cleanup-step"] as const).map(action => z.object({
    action: z.literal(action), roomId: z.uuid(), season: z.number().int(),
    week: z.number().int().min(2).max(17), version: z.number().int().min(0),
  }).strict()),
]);
export async function POST(request: Request) {
  try {
    await authenticate(request);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "Invalid single-player Sleeper request.");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new HttpError(503, "Sleeper integration unavailable.");
    const result = await fetch(`${url}/functions/v1/sleeper-player`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: request.headers.get("authorization")! },
      body: JSON.stringify(parsed.data), cache: "no-store", signal: AbortSignal.timeout(90_000),
    });
    const data = await result.json();
    if (!result.ok) throw new HttpError(result.status, data.error || "Sleeper unavailable. Refresh status before doing anything else.");
    return json(data);
  } catch (error) {
    return failure(error);
  }
}
