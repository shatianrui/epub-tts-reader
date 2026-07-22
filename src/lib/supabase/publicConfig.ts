/**
 * Publishable Supabase credentials (safe for browser / public repos).
 * Prefer CI Variables/Secrets when present; these are fallbacks for GitHub Pages.
 */
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://xfrxznnzeutomvqxjknr.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "sb_publishable_AY8ltacfl8YQNVp0K4aRlg_y8AO0X9n";
