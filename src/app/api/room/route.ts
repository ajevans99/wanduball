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
    if (data.owner_id !== userId) {
      const access = await database.from("room_commissioners")
        .select("user_id").eq("room_id", body.roomId).eq("user_id", userId).maybeSingle();
      if (access.error) throw new HttpError(503, "Room access is unavailable. Please try again.");
      if (!access.data) throw new HttpError(403, "Only this room's commissioners can change it.");
    }
    const current = rowSchema.parse(data);
    if (body.roomId === "69103cd4-0f84-4ce1-b9d1-dfb3096771bc"
      && body.command.type === "assignment-status" && body.command.field === "applied") {
      throw new HttpError(422, "Applied status in this room requires live Sleeper verification.");
    }
    if (current.version !== body.version) throw new HttpError(409, "The room changed. Refresh it before trying again.");

    let state;
    try {
      state = stateSchema.parse(transition(current.state, body.command, randomInt));
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : "That command is not allowed.");
    }
    // The database locks the room and rechecks access and CAS together, so a
    // commissioner removed after the preliminary read cannot commit this state.
    const result = await database.rpc("commit_room_command", {
      p_room_id: body.roomId,
      p_user_id: userId,
      p_expected_version: current.version,
      p_new_state: state,
    });
    if (result.error?.code === "PT403") throw new HttpError(403, "You no longer have permission to change this room.");
    if (result.error?.code === "PT404") throw new HttpError(404, "Room not found.");
    if (result.error?.code === "PT409") throw new HttpError(409, "Another command won the race. Refresh the room before trying again.");
    if (result.error?.code === "PT422") throw new HttpError(422, result.error.message);
    if (result.error) throw new HttpError(503, "Could not save the room. Refresh before retrying.");
    if (!result.data) throw new HttpError(409, "Another command won the race. Refresh the room before trying again.");
    return json(rowSchema.parse(result.data));
  } catch (error) {
    return failure(error);
  }
}
