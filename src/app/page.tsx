import Wanduball from "@/components/wanduball";

export default function Home() {
  return <Wanduball defaultRoomId={process.env.DEFAULT_ROOM_ID?.trim() || null} />;
}
