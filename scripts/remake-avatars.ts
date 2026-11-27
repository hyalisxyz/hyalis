/**
 * Makes agent avatars again, for example after the avatar style changed. Old images and their
 * sealed receipts stay; each marked agent gets a new avatar, paid for afresh and sealed anew.
 *
 *   node --env-file=.env scripts/remake-avatars.ts --stale          # preview: avatars made from an older prompt
 *   node --env-file=.env scripts/remake-avatars.ts --stale --yes    # mark them
 *   node --env-file=.env scripts/remake-avatars.ts --agent <id> --yes
 *
 * On the server: docker exec agent-utility node scripts/remake-avatars.ts --stale --yes
 */
import { parseArgs } from "node:util";
import { loadConfig, loadMarkets } from "../src/config.ts";
import { openDb } from "../src/store/db.ts";
import { getAgent } from "../src/engine/agents.ts";
import { avatarPrompt, remakeAvatars, type MediaRow } from "../src/media/avatars.ts";

const { values } = parseArgs({ options: { stale: { type: "boolean" }, agent: { type: "string", multiple: true }, yes: { type: "boolean" } } });
const config = loadConfig();
const markets = loadMarkets();
const assetOf = (s: string) => (markets.find((m) => m.symbol === s)?.assetClass === "crypto" ? "crypto" : "equity") as "equity" | "crypto";
const db = openDb(config.DB_PATH);

const ready = db.prepare("SELECT * FROM agent_media WHERE status = 'ready'").all() as unknown as MediaRow[];
let ids: string[] = values.agent ?? [];
if (values.stale) {
  for (const m of ready) {
    const agent = getAgent(db, m.agent_id);
    if (agent && m.prompt !== avatarPrompt(agent, assetOf)) ids.push(m.agent_id);
  }
}
ids = [...new Set(ids)];
if (!ids.length) {
  console.log("Nothing to remake.");
  process.exit(0);
}
for (const id of ids) console.log(`${values.yes ? "remake" : "would remake"} ${id} (${getAgent(db, id)?.name ?? "unknown agent"})`);
if (!values.yes) {
  console.log("Preview only. Add --yes to mark them; the service makes the new avatars in its next rounds.");
  process.exit(0);
}
const marked = remakeAvatars(db, ids);
console.log(`Marked ${marked.length} avatar(s). New ones are made one a minute, within the daily budget.`);
