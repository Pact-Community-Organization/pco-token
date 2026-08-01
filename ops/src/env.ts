// env.ts — shared config + transaction helpers for the PCO token ops harness.
//
// Devnet by default (the dress-rehearsal target). Mainnet values are staged
// behind environment variables and NEVER defaulted: setting PCO_NETWORK=
// mainnet01 is a deliberate act performed only during the founder ceremony.
import {
  Pact,
  createClient,
  createSignWithKeypair,
  type ChainId,
  type ICommandResult,
} from '@kadena/client';
import { genKeyPair, restoreKeyPairFromSecretKey } from '@kadena/cryptography-utils';

export const HOST = process.env.PCO_HOST ?? 'http://localhost:8090';
export const NETWORK_ID = process.env.PCO_NETWORK ?? 'recap-development';
export const NS = process.env.PCO_NS ?? 'free'; // mainnet: n_<derived>
export const CHAINS = Array.from({ length: 20 }, (_, i) => String(i));
export const HUB = '0';
export const GAS_PRICE = 1e-8;

export const client = createClient(
  ({ chainId, networkId }) => `${HOST}/chainweb/0.0/${networkId}/chain/${chainId}/pact`,
);

export type Keypair = { account: string; publicKey: string; secretKey: string };

// Devnet genesis faucet (public devnet keys — no secret here).
export const SENDER00: Keypair = {
  account: 'sender00',
  publicKey: '368820f80c324bbc7c2b0610688a7da43e39f91d118732671cd9c7500ff43cca',
  secretKey: '251a920c403ae8c8f65f59142316af3c82b631fba46ddea92ee8c95035bd2898',
};

export function getPubFromSecret(secretHex: string): string {
  // ed25519 public key from a 32-byte secret seed (Kadena keypair encoding).
  return restoreKeyPairFromSecretKey(secretHex).publicKey;
}

export function newKey(): Keypair {
  const kp = genKeyPair();
  return { account: `k:${kp.publicKey}`, publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export function unwrap(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === 'object') {
    if ('int' in v) return Number(v.int);
    if ('decimal' in v) return Number(v.decimal);
    if ('time' in v) return v.time;
    if ('timep' in v) return v.timep;
  }
  return v;
}

// `data` is optional but NOT decorative: the RUNBOOK's namespace preflight runs
// `(ns.create-principal-namespace (read-keyset 'pco-gov))`, which cannot resolve
// without env-data. Without this parameter that step was documented but not
// executable — the same shape as the build-tx guard that refused to build the
// step whose job was to derive `ns`.
export async function localCall(code: string, chainId: string, data?: Record<string, any>): Promise<any> {
  let b = Pact.builder.execution(code);
  for (const [k, v] of Object.entries(data ?? {})) b = b.addData(k, v);
  const tx = b
    .setMeta({ chainId: chainId as ChainId, senderAccount: SENDER00.account, gasLimit: 150000, gasPrice: GAS_PRICE })
    .setNetworkId(NETWORK_ID)
    .createTransaction();
  const r = await client.local(tx, { preflight: false, signatureVerification: false });
  if (r.result.status !== 'success') {
    throw new Error(`local(${code.slice(0, 80)}) FAILED: ${JSON.stringify((r.result as any).error).slice(0, 300)}`);
  }
  return unwrap((r.result as any).data);
}

export type SignerSpec = {
  kp: Keypair;
  caps?: (wc: (name: string, ...args: any[]) => any) => any[]; // omit = unscoped
};

export type TxSpec = {
  code: string;
  chainId: string;
  signers: SignerSpec[];      // first signer pays gas unless sender is given
  sender?: string;            // gas-paying account (e.g. the station principal)
  gasLimit?: number;
  gasPrice?: number;
  data?: Record<string, any>;
  label: string;
};

function build(o: TxSpec) {
  let b: any = Pact.builder.execution(o.code);
  for (const s of o.signers) {
    b = s.caps ? b.addSigner(s.kp.publicKey, s.caps) : b.addSigner(s.kp.publicKey);
  }
  for (const [k, v] of Object.entries(o.data ?? {})) b = b.addData(k, v);
  return b
    .setMeta({
      chainId: o.chainId as ChainId,
      senderAccount: o.sender ?? o.signers[0].kp.account,
      gasLimit: o.gasLimit ?? 150000,
      gasPrice: o.gasPrice ?? GAS_PRICE,
      ttl: 1800,
    })
    .setNetworkId(NETWORK_ID)
    .createTransaction();
}

async function signAll(tx: any, signers: SignerSpec[]) {
  let t = tx;
  for (const s of signers) t = await createSignWithKeypair(s.kp)(t);
  return t;
}

// Submit and poll to confirmation; throws on failure.
export async function send(o: TxSpec): Promise<ICommandResult> {
  const signed = await signAll(build(o), o.signers);
  const desc = await client.submit(signed as any);
  const r = await client.pollOne(desc, { timeout: 300_000, interval: 3_000 });
  if (r.result.status !== 'success') {
    throw new Error(`${o.label} FAILED (${desc.requestKey}): ${JSON.stringify((r.result as any).error).slice(0, 400)}`);
  }
  return r;
}

// Preflight (/local with signature verification + buy-gas simulation):
// the safe way to prove a NEGATIVE without burning a mempool slot.
export async function preflight(o: TxSpec): Promise<{ ok: boolean; error: string }> {
  const signed = await signAll(build(o), o.signers);
  const r = await client.local(signed as any, { preflight: true, signatureVerification: true });
  return r.result.status === 'success'
    ? { ok: true, error: '' }
    : { ok: false, error: JSON.stringify((r.result as any).error).slice(0, 400) };
}

// 2-step cross-chain defpact: step 0 on src, SPV proof, continuation on target.
export async function xchain(o: {
  code: string; src: string; target: string;
  signers: SignerSpec[]; contGasPayer: Keypair; label: string;
  data?: Record<string, any>;
}): Promise<{ step0: ICommandResult; step1: ICommandResult; pactId: string }> {
  const signed = await signAll(build({ ...o, chainId: o.src }), o.signers);
  const desc0 = await client.submit(signed as any);
  const r0 = await client.pollOne(desc0, { timeout: 300_000, interval: 3_000 });
  if (r0.result.status !== 'success') {
    throw new Error(`${o.label} step0 FAILED: ${JSON.stringify((r0.result as any).error).slice(0, 300)}`);
  }
  const proof = await client.pollCreateSpv(desc0, o.target as ChainId);
  const cont = Pact.builder
    .continuation({ pactId: desc0.requestKey, step: 1, rollback: false, proof })
    .addSigner(o.contGasPayer.publicKey)
    .setMeta({ chainId: o.target as ChainId, senderAccount: o.contGasPayer.account, gasLimit: 150000, gasPrice: GAS_PRICE, ttl: 1800 })
    .setNetworkId(NETWORK_ID)
    .createTransaction();
  const signedCont = await createSignWithKeypair(o.contGasPayer)(cont);
  const r1 = await client.pollOne(await client.submit(signedCont as any), { timeout: 300_000, interval: 3_000 });
  if (r1.result.status !== 'success') {
    throw new Error(`${o.label} step1 FAILED: ${JSON.stringify((r1.result as any).error).slice(0, 300)}`);
  }
  return { step0: r0, step1: r1, pactId: desc0.requestKey };
}

// Evidence recorder — becomes the devnet-rehearsal evidence document.
export type Check = { phase: string; check: string; ok: boolean; detail: string };
export const checks: Check[] = [];
export function record(phase: string, check: string, ok: boolean, detail = '') {
  checks.push({ phase, check, ok, detail });
  console.log(`  ${ok ? '✓' : '✗ FAIL'} [${phase}] ${check}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}
