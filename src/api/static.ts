/**
 * How long browsers may keep a website file. Vite names everything in /assets after its content,
 * so those never change and are kept for a year. Pages are checked on every visit, so a deploy
 * shows at once. Fonts and the rest keep their names across deploys, so they are kept for a day.
 */
export function cacheFor(path: string): string {
  if (/[\\/]assets[\\/]/.test(path)) return "public, max-age=31536000, immutable";
  // The path may name the compressed copy (index.html.br).
  if (/\.html(\.br|\.gz|\.zst)?$/.test(path)) return "no-cache";
  return "public, max-age=86400";
}
