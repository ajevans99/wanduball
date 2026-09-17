import { z } from "zod";

export function selectRoom(params: { get(name: string): string | null }, defaultRoomId: string | null) {
  if (params.get("mode") === "practice") return { roomId: null, error: "" };
  const candidate = params.get("room") ?? defaultRoomId;
  if (candidate === null) return { roomId: null, error: "" };
  if (!z.uuid().safeParse(candidate).success) {
    return { roomId: null, error: "Invalid room ID. Use a valid room link or open /?mode=practice." };
  }
  return { roomId: candidate, error: "" };
}
