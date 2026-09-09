import { z } from "zod";
import { failure, HttpError, json, readJson } from "@/lib/server/http";
import { authenticate, roomClient } from "@/lib/server/supabase";

export const runtime = "nodejs";

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    roomId: z.uuid(),
    action: z.literal("add"),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  }).strict(),
  z.object({
    roomId: z.uuid(),
    action: z.literal("remove"),
    userId: z.uuid(),
  }).strict(),
]);
const accessSchema = z.object({
  canEdit: z.boolean(),
  isOwner: z.boolean(),
  commissioners: z.array(z.object({ userId: z.uuid(), email: z.string() })),
});

function accessResponse(data: unknown, error: { code?: string } | null) {
  if (error) {
    const errors: Record<string, [number, string]> = {
      PT403: [403, "Only the room creator can manage commissioner access."],
      PT404: [404, "Room not found."],
      PT410: [404, "No account was found for that email. They must sign up and confirm their email first."],
      PT422: [422, "That account must have a confirmed, unique email before it can be added."],
      PT400: [400, "The room creator cannot be added or removed as an additional commissioner."],
    };
    const [status, message] = errors[error.code ?? ""] ?? [503, "Commissioner access is unavailable. Please try again."];
    throw new HttpError(status, message);
  }
  const access = accessSchema.parse(data);
  // Defense in depth: never forward membership identities to non-owners.
  return json({ ...access, commissioners: access.isOwner ? access.commissioners : [] });
}

export async function GET(request: Request) {
  try {
    const userId = await authenticate(request);
    const roomId = z.uuid().safeParse(new URL(request.url).searchParams.get("room"));
    if (!roomId.success) throw new HttpError(400, "Supply a valid room UUID in the room query parameter.");
    const { data, error } = await roomClient(true).rpc("room_commissioner_access", {
      p_room_id: roomId.data,
      p_user_id: userId,
    });
    return accessResponse(data, error);
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await authenticate(request);
    const parsed = requestSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "Supply a valid room UUID and an add email or remove userId.");
    const body = parsed.data;
    const { data, error } = await roomClient(true).rpc("manage_room_commissioner", {
      p_room_id: body.roomId,
      p_user_id: userId,
      p_action: body.action,
      p_email: body.action === "add" ? body.email : null,
      p_member_user_id: body.action === "remove" ? body.userId : null,
    });
    return accessResponse(data, error);
  } catch (error) {
    return failure(error);
  }
}
