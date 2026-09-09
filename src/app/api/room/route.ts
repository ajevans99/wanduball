import { randomInt } from "node:crypto";
import { z } from "zod";
import { commandSchema, stateSchema, transition } from "@/lib/game";
import { initialState } from "@/lib/seed";
import { failure, HttpError, json, readJson } from "@/lib/server/http";
import { authenticate, roomClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

const roomIdSchema = z.uuid();
const requestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create") }).strict(),
  z.object({
    type: z.literal("command"),
    roomId: roomIdSchema,
    version: z.number().int().min(0).max(2_147_483_646),
    command: commandSchema,
  }).strict(),
]);
const rowSchema = z.object({
  state: stateSchema,
  version: z.number().int().nonnegative(),
});

export async function GET(request: Request) {
  try {
    const roomId = roomIdSchema.safeParse(new URL(request.url).searchParams.get("room"));
    if (!roomId.success) throw new HttpError(400, "Supply a valid room UUID in the room query parameter.");
    const { data, error } = await roomClient()
      .from("rooms").select("state,version").eq("id", roomId.data).maybeSingle();
    if (error) throw new HttpError(503, "Room storage is unavailable. Check the Supabase configuration and migration.");
    if (!data) throw new HttpError(404, "Room not found. Check the shared room link.");
    return json(rowSchema.parse(data));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await authenticate(request);
    const parsed = requestSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "Invalid room request or command.");
    const body = parsed.data;
    const database = roomClient(true);
    if (body.type === "create") {
      const state = stateSchema.parse({
        ...initialState(),
        players: [],
        assignments: [],
        changes: [],
        source: "Awaiting Sleeper import — no player rankings loaded",
      });
      const { data, error } = await database.from("rooms")
        .insert({ owner_id: userId, state, version: 0 })
        .select("id,state,version").single();
      if (error || !data) throw new HttpError(503, "Could not create the room. Check the Supabase configuration and migration.");
      return json({ roomId: data.id, ...rowSchema.parse(data) }, 201);
    }

    const { data, error } = await database.from("rooms")
      .select("owner_id,state,version").eq("id", body.roomId).maybeSingle();
    if (error) throw new HttpError(503, "Room storage is unavailable. Please try again.");
    if (!data) throw new HttpError(404, "Room not found.");
    if (data.owner_id !== userId) throw new HttpError(403, "Only this room's commissioner can change it.");
    const current = rowSchema.parse(data);
    if (current.version !== body.version) throw new HttpError(409, "The room changed. Refresh it before trying again.");

    let state;
    try {
      state = transition(current.state, body.command, randomInt);
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : "That command is not allowed.");
    }
    const result = await database.from("rooms")
      .update({ state, version: current.version + 1 })
      .eq("id", body.roomId).eq("owner_id", userId).eq("version", current.version)
      .select("state,version").maybeSingle();
    if (result.error) throw new HttpError(503, "Could not save the room. Refresh before retrying.");
    if (!result.data) throw new HttpError(409, "Another command won the race. Refresh the room before trying again.");
    return json(rowSchema.parse(result.data));
  } catch (error) {
    return failure(error);
  }
}
