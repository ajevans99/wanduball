import "server-only";
import { createClient } from "@supabase/supabase-js";
import { HttpError } from "./http";

export function roomClient(service = false) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = service
    ? process.env.SUPABASE_SERVICE_ROLE_KEY
    : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new HttpError(503, "Shared rooms are not configured. Set the Supabase environment variables and apply the database migration.");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      }),
    },
  });
}

export async function authenticate(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Sign in as the commissioner to change a shared room.");
  const { data, error } = await roomClient().auth.getUser(token);
  if (error) {
    if (!error.status || error.status === 429 || error.status >= 500) {
      throw new HttpError(503, "Supabase authentication is unavailable. Please try again.");
    }
    throw new HttpError(401, "Your session is invalid or expired. Please sign in again.");
  }
  if (!data.user) throw new HttpError(401, "Please sign in again.");
  return data.user.id;
}
