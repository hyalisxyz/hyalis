/**
 * Creates the wallet that pays the image service for agent avatars (x402) and stores its key in .env.
 * The key is written to .env only and never printed.
 *
 * Fund the printed address with a little USDG on Robinhood Chain (1 USDG pays for about 1,300
 * avatars at today's price). It needs no ETH: the service pays the gas of each payment.
 *
 *   node scripts/new-media-wallet.ts
 */
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
const existing = /^MEDIA_PAYER_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(env);
if (existing) {
  console.log(`A media payer wallet already exists in .env: ${privateKeyToAccount(existing[1] as `0x${string}`).address}`);
  process.exit(0);
}
const key = generatePrivateKey();
appendFileSync(".env", `${env.endsWith("\n") || env === "" ? "" : "\n"}\n# Wallet that pays the image service for avatars with x402 (USDG only). Never commit or share.\nMEDIA_PAYER_KEY=${key}\n`, { mode: 0o600 });
console.log(`New media payer wallet: ${privateKeyToAccount(key).address}`);
console.log("Its key is in .env. Send it a little USDG on Robinhood Chain; it needs no ETH.");
