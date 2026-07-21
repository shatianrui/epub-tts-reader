"use client";

import { createBrowserClient } from "@supabase/auth-helpers-nextjs";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

let clientInstance: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabase() {
  if (typeof window === "undefined") {
    throw new Error("getSupabase() can only be called on the client side");
  }
  if (!clientInstance) {
    clientInstance = createClient();
  }
  return clientInstance;
}
