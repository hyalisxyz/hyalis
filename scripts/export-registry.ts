/**
 * Copies compiled contract ABIs and bytecode where TypeScript can import them:
 *  - ReceiptRegistry for the backend
 *  - MockToken for the end-to-end tests (a stand-in for the project token)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

function exportOne(name: string, src: string, dest: string) {
  const out = JSON.parse(readFileSync(`contracts/out/${src}/${name}.json`, "utf8"));
  writeFileSync(dest, JSON.stringify({ contractName: name, abi: out.abi, bytecode: out.bytecode.object }, null, 2) + "\n");
  console.log(`exported ${name}: ${out.abi.length} ABI entries, ${(out.bytecode.object.length - 2) / 2} bytes`);
}

exportOne("ReceiptRegistry", "ReceiptRegistry.sol", "src/chain/ReceiptRegistry.json");
exportOne("AgentVaultFactory", "AgentVaultFactory.sol", "src/chain/AgentVaultFactory.json");
exportOne("AgentVault", "AgentVault.sol", "src/chain/AgentVault.json");
exportOne("UniswapV3Adapter", "UniswapV3Adapter.sol", "src/chain/UniswapV3Adapter.json");
mkdirSync("test/fixtures", { recursive: true });
exportOne("MockToken", "MockToken.sol", "test/fixtures/MockToken.json");
exportOne("ShortPayAdapter", "VaultMocks.sol", "test/fixtures/ShortPayAdapter.json");
exportOne("GreedyAdapter", "VaultMocks.sol", "test/fixtures/GreedyAdapter.json");
exportOne("RejectEth", "VaultMocks.sol", "test/fixtures/RejectEth.json");
exportOne("MockIdentityRegistry", "MockIdentityRegistry.sol", "test/fixtures/MockIdentityRegistry.json");
