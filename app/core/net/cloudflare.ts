/**
 * Detects a Cloudflare browser challenge ("Just a moment…", Turnstile, managed
 * challenge). AniVerse never solves challenges itself: a real Chromium window in
 * the source's own session runs them, and the user completes interactive ones.
 */
export function isCloudflareChallenge(status: number, headers: Record<string, string>, body: string): boolean {
  const h = lowerKeys(headers);
  if (h['cf-mitigated'] === 'challenge') return true;
  const fromCloudflare = (h.server ?? '').toLowerCase().includes('cloudflare') || 'cf-ray' in h;
  if (!fromCloudflare) return false;
  if (status !== 403 && status !== 503 && status !== 429) return false;
  return CHALLENGE_MARKERS.test(body.slice(0, 20000));
}

/** Title shown by Cloudflare interstitials in any language Cloudflare ships. */
export function isChallengeTitle(title: string): boolean {
  return /^(just a moment|attention required|un instant|einen moment|un momento|um momento|請稍候|しばらくお待ちください|잠시만 기다리십시오)/i.test(title.trim());
}

const CHALLENGE_MARKERS = /(<title>\s*Just a moment|challenge-platform|cf_chl_opt|cf-chl-|cf-turnstile|Attention Required! \| Cloudflare|__cf_chl_)/i;

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}
