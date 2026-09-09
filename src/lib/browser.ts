import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const supabase = url && key ? createClient(url, key) : null;
export function randomIndex(max: number): number {
    const limit = Math.floor(0x100000000 / max) * max;
    const values = new Uint32Array(1);
    do {
        crypto.getRandomValues(values);
    } while (values[0] >= limit);
    return values[0] % max;
}
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const data = await response.json();
    if (!response.ok)
        throw new Error(data.error ?? `Request failed (${response.status}).`);
    return data;
}
