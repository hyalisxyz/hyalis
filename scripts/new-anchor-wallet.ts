/**
 * Creates a dedicated wallet for publishing receipt roots and stores its key in .env.
 * The key is written to .env only and never printed. Fund the printed address with a
 * small amount of ETH on Robinhood Chain to pay for gas.
 *
 *   npm run anchor:wallet
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const existing = /^ANCHOR_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(env);
if (existing) {
  console.log(`An anchor wallet already exists in .env: ${privateKeyToAccount(existing[1] as `0x${string}`).address}`);
  process.exit(0);
}
const key = generatePrivateKey();
appendFileSync(".env", `${env.endsWith("\n") || env === "" ? "" : "\n"}\n# Wallet that publishes receipt roots. Never commit or share.\nANCHOR_PRIVATE_KEY=${key}\n`, { mode: 0o600 });
console.log(`New anchor wallet: ${privateKeyToAccount(key).address}`);
console.log("Its key is in .env. Back up .env somewhere safe; if it is lost, deploy a new registry.");
