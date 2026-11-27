/**
 * After a deploy, a tab opened earlier can ask for a code chunk that no longer exists. Instead
 * of a blank page, the tab loads the new version: once, and not again within half a minute, so
 * a chunk that is really broken cannot cause a reload loop.
 */
const KEY = "hyalis:reloaded-at";

export function reloadForNewVersion(): boolean {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) ?? 0);
  } catch {
    /* storage blocked: still reload, the time check below keeps it to once per load */
  }
  if (Date.now() - last < 30_000) return false;
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  window.location.reload();
  return true;
}

/** A failed dynamic import (a missing chunk), as browsers word it. */
export const isChunkError = (e: unknown) =>
  /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically|ChunkLoadError|MIME type/i.test(String((e as Error)?.message ?? e));
