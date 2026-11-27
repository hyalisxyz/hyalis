/**
 * Makes the recovery phrase for real-money agent wallets (LIVE_MNEMONIC). Each live agent gets
 * the wallet at its index under this phrase.
 *
 *   node scripts/new-live-wallet.ts >> .env
 *
 * Only the line for .env goes to standard output (so it can be appended without being shown);
 * the first wallet addresses go to standard error. Refuses to run if .env already has a phrase.
 */
import { existsSync, readFileSync } from "node:fs";
import { generateMnemonic, english, mnemonicToAccount } from "viem/accounts";

if (existsSync(".env") && /^LIVE_MNEMONIC=/m.test(readFileSync(".env", "utf8"))) {
  console.error(".env already has LIVE_MNEMONIC; not making another one (it would orphan the funded wallets).");
  process.exit(1);
}
if (process.stdout.isTTY) {
  console.error("Standard output is a terminal: redirect it into .env (>> .env) so the phrase is not shown.");
  process.exit(1);
}
const phrase = generateMnemonic(english, 256);
process.stdout.write(`LIVE_MNEMONIC="${phrase}"\nLIVE_TRADING=false\n`);
for (let i = 0; i < 4; i++) console.error(`wallet ${i}: ${mnemonicToAccount(phrase, { addressIndex: i }).address}`);
