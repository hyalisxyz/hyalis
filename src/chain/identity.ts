import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  getAddress,
  parseAbi,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { CHAIN_ID } from "../config.ts";

/**
 * ERC-8004 ("Trustless Agents") Identity Registry: one ERC-721 token per agent whose tokenURI
 * (the "agentURI") points at the agent's registration file. On Robinhood Chain the registry is
 * the shared singleton at 0x8004A169…a432 (an upgradeable proxy, version 2.0.0).
 *
 * Only the calls this backend makes are listed. They follow the published standard and the
 * deployed contract; no code from any other project is used.
 */
export const IDENTITY_REGISTRY = getAddress("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");

export const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function getVersion() view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "error ERC721NonexistentToken(uint256 tokenId)",
]);

/** The standard's global name for a registry: `eip155:<chainId>:<address>`. */
export const agentRegistryId = (registry: string, chainId = CHAIN_ID) => `eip155:${chainId}:${getAddress(registry)}`;

/** Where an agent's registration file is served, under a public base URL. */
export const registrationUri = (base: string, agentId: string) => `${base.replace(/\/+$/, "")}/v1/agents/${agentId}/registration.json`;

/** ERC-8004 agent ids are uint256; they are kept as decimal strings so nothing is rounded. */
export const TOKEN_ID = /^(0|[1-9]\d{0,77})$/;

export type OnChainIdentity = { exists: true; owner: `0x${string}`; uri: string } | { exists: false };

/** True when `e` is the registry saying the token does not exist (as opposed to a network failure). */
export function isNonexistent(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === "ERC721NonexistentToken";
}

/**
 * Reads owner and agentURI of an ERC-8004 agent. Returns `{ exists: false }` only when the
 * registry itself says the id does not exist; any other failure (RPC down, timeout) throws,
 * so a flaky connection is never mistaken for a missing identity.
 */
export async function readIdentity(client: PublicClient, registry: `0x${string}`, tokenId: bigint): Promise<OnChainIdentity> {
  try {
    const owner = (await client.readContract({ address: registry, abi: IDENTITY_ABI, functionName: "ownerOf", args: [tokenId] })) as `0x${string}`;
    const uri = (await client.readContract({ address: registry, abi: IDENTITY_ABI, functionName: "tokenURI", args: [tokenId] })) as string;
    return { exists: true, owner: getAddress(owner), uri };
  } catch (e) {
    if (isNonexistent(e)) return { exists: false };
    throw e;
  }
}

/** Every `Registered` event the registry emitted in a transaction receipt. */
export function registrationsIn(receipt: Pick<TransactionReceipt, "logs">, registry: `0x${string}`): Array<{ tokenId: bigint; uri: string; owner: `0x${string}` }> {
  const out: Array<{ tokenId: bigint; uri: string; owner: `0x${string}` }> = [];
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(registry)) continue;
    try {
      const ev = decodeEventLog({ abi: IDENTITY_ABI, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      if (ev.eventName === "Registered") out.push({ tokenId: ev.args.agentId, uri: ev.args.agentURI, owner: getAddress(ev.args.owner) });
    } catch {
      // Transfer, MetadataSet and other events of the registry are not needed here.
    }
  }
  return out;
}
