import { failure, HttpError, json } from "@/lib/server/http";
import { importSleeper, sleeperQuerySchema } from "@/lib/server/sleeper";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const parsed = sleeperQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      throw new HttpError(400, "Provide a numeric leagueId, season (2020–2100), week (1–18), optional statsSeason, and ranking=league|ppr|half_ppr|std (default: league).");
    }
    return json(await importSleeper(parsed.data));
  } catch (error) {
    return failure(error);
  }
}
