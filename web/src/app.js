// PCO community token — claim (and send), straight from the browser.
//
// No wallet, no KDA needed to CLAIM: the page generates a throwaway ed25519
// key (kept in localStorage + downloadable backup), and the claim is sponsored
// by the on-chain PCO gas station. All crypto is bundled locally (@noble); the
// page talks only to the configured Chainweb API.
//
// SCOPE — this page is claim + transfer ONLY. It carries no governance
// surface, deliberately. Governance moved to admin-authored ranked-choice
// questions (2..5 named options, ballots are RANKINGS, tallies are Borda
// scores), and the canonical UI for it is the website repo's /token page.
// Holders do not open proposals: `create-proposal` is PROPOSAL-OPS-gated.
// A second, hand-maintained ranked-ballot surface here would be one more
// artifact to drift out of sync with the contracts — which is exactly how
// this page came to ship a vote button that could not cast a vote.
import { ed25519 } from '@noble/curves/ed25519';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// CONFIG — devnet by default. The mainnet block is STAGED and must only be
// activated at launch, after the go/no-go checklist signs off.
// ---------------------------------------------------------------------------
const CFG = {
  host: 'http://localhost:8090',
  networkId: 'recap-development',
  ns: 'user',   // devnet: the v2 (rounds) stack lives in `user`; `free` holds the retired v1
  chain: '0',
  // --- MAINNET (staged; do not enable before the go/no-go checklist) ---
  // host: 'https://chainweb.eckowallet.com',
  // networkId: 'mainnet01',
  // ns: 'n_<FILL: derived principal namespace>',
  // chain: '0',
};

const T = `${CFG.ns}.pco`;
const C = `${CFG.ns}.pco-claim`;
const G = `${CFG.ns}.pco-gas-station`;
const API = `${CFG.host}/chainweb/0.0/${CFG.networkId}/chain/${CFG.chain}/pact/api/v1`;

// ---------------------------------------------------------------------------
// crypto + envelope helpers
// ---------------------------------------------------------------------------
const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function hashCmd(cmd) {
  return b64url(blake2b(new TextEncoder().encode(cmd), { dkLen: 32 }));
}

function signHash(hashB64, privHex) {
  const pad = hashB64.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
  return bytesToHex(ed25519.sign(bytes, hexToBytes(privHex)));
}

function loadKey() {
  const stored = localStorage.getItem('pco-key');
  if (stored) return JSON.parse(stored);
  const priv = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const pub = bytesToHex(ed25519.getPublicKey(hexToBytes(priv)));
  const key = { priv, pub, account: `k:${pub}` };
  localStorage.setItem('pco-key', JSON.stringify(key));
  return key;
}

async function local(code) {
  const cmd = JSON.stringify({
    networkId: CFG.networkId,
    payload: { exec: { code, data: {} } },
    signers: [],
    meta: { chainId: CFG.chain, sender: 'reader', gasLimit: 150000, gasPrice: 1e-8, ttl: 600, creationTime: Math.floor(Date.now() / 1000) - 30 },
    nonce: `r:${Date.now()}:${Math.random()}`,
  });
  const r = await fetch(`${API}/local`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, hash: hashCmd(cmd), sigs: [] }),
  });
  const j = await r.json();
  if (j.result?.status !== 'success') throw new Error(JSON.stringify(j.result?.error?.message ?? j));
  return j.result.data;
}

const num = (v) => (v && typeof v === 'object' ? Number(v.decimal ?? v.int ?? NaN) : Number(v));

// sponsored exec: the station pays; our throwaway key signs its scoped caps.
async function sponsored(code, extraCaps, dataObj) {
  const key = loadKey();
  const station = state.station;
  const cmd = JSON.stringify({
    networkId: CFG.networkId,
    payload: { exec: { code, data: dataObj ?? {} } },
    signers: [{
      pubKey: key.pub,
      clist: [
        ...extraCaps,
        { name: `${G}.GAS_PAYER`, args: ['web', { int: 6000 }, { decimal: '0.0000001' }] },
      ],
    }],
    meta: { chainId: CFG.chain, sender: station, gasLimit: 6000, gasPrice: 1e-8, ttl: 1800, creationTime: Math.floor(Date.now() / 1000) - 30 },
    nonce: `pco-web:${Date.now()}`,
  });
  const hash = hashCmd(cmd);
  const body = JSON.stringify({ cmds: [{ cmd, hash, sigs: [{ sig: signHash(hash, key.priv) }] }] });
  const r = await fetch(`${API}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok) throw new Error(`send: ${r.status} ${await r.text()}`);
  const { requestKeys } = await r.json();
  return pollTx(requestKeys[0]);
}

async function pollTx(rk) {
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 3000));
    const r = await fetch(`${API}/poll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestKeys: [rk] }),
    });
    const j = await r.json();
    if (j[rk]) {
      if (j[rk].result.status === 'success') return j[rk];
      throw new Error(j[rk].result.error?.message ?? 'transaction failed');
    }
  }
  throw new Error('timed out waiting for the transaction');
}

// ---------------------------------------------------------------------------
// Wallet connect — for the actions the gas station does NOT sponsor (transfer
// and cross-chain transfer). These need a signer that holds KDA and pays its
// own gas; the throwaway key holds none. eckoWallet is the dominant
// Kadena-ecosystem wallet and exposes a browser-extension API (window.kadena).
// (The claim path below stays gasless via the throwaway key + the station.)
// ---------------------------------------------------------------------------
function ecko() {
  return typeof window !== 'undefined' && window.kadena && window.kadena.isKadena ? window.kadena : null;
}

async function connectWallet() {
  const k = ecko();
  if (!k) {
    setStatus('No Kadena wallet detected. Install eckoWallet (or another Kadena wallet) to send PCO.', 'err');
    return;
  }
  try {
    await k.request({ method: 'kda_connect', networkId: CFG.networkId });
    const acc = await k.request({ method: 'kda_checkStatus', networkId: CFG.networkId });
    const account = acc?.account?.account ?? acc?.account;
    if (!account) throw new Error('wallet did not return an account');
    state.wallet = { account, publicKey: (acc?.account?.publicKey) ?? account.replace(/^k:/, '') };
    setStatus(`Wallet connected: ${account.slice(0, 16)}…`, 'ok');
    renderWallet();
    await refresh();
  } catch (e) {
    setStatus(`Wallet connect failed: ${e.message ?? e}`, 'err');
  }
}

function disconnectWallet() {
  state.wallet = null;
  renderWallet();
  setStatus('Wallet disconnected.', 'info');
  refresh();
}

// Sign + send a SELF-PAID action with the connected wallet (it pays coin.GAS).
async function walletExec(code, caps, dataObj) {
  const k = ecko();
  const w = state.wallet;
  if (!k || !w) throw new Error('connect a wallet first');
  const signingCmd = {
    networkId: CFG.networkId,
    payload: { exec: { code, data: dataObj ?? {} } },
    // the wallet's account pays its OWN gas — no station, plain coin.GAS
    caps: [
      { role: 'Gas', description: 'Pay gas', cap: { name: 'coin.GAS', args: [] } },
      ...caps.map((c) => ({ role: c.role ?? 'Action', description: c.description ?? c.name, cap: { name: c.name, args: c.args } })),
    ],
    sender: w.account,
    chainId: CFG.chain,
    gasLimit: 2500,
    gasPrice: 1e-7,
    ttl: 1800,
    signingPubKey: w.publicKey,
  };
  const res = await k.request({ method: 'kda_requestSign', networkId: CFG.networkId, signingCmd });
  const signed = res?.signedCmd ?? res;
  if (!signed || !signed.cmd) throw new Error('wallet did not return a signed command');
  const send = await fetch(`${API}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmds: [signed] }),
  });
  if (!send.ok) throw new Error(`send: ${send.status} ${await send.text()}`);
  const { requestKeys } = await send.json();
  return pollTx(requestKeys[0]);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const state = { station: null, rounds: [], lastAction: 0, wallet: null };

function renderWallet() {
  const w = state.wallet;
  $('wallet-account').textContent = w ? w.account : 'not connected';
  $('connect-btn').style.display = w ? 'none' : '';
  $('disconnect-btn').style.display = w ? '' : 'none';
  // action buttons need a wallet
  for (const id of ['transfer-btn', 'xtransfer-btn']) {
    const el = $(id); if (el) el.disabled = !w;
  }
}

function setStatus(msg, kind = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.dataset.kind = kind;
  if (kind === 'ok' || kind === 'err') state.lastAction = Date.now();
}

// Pact time values arrive as {time:...} or {timep:...} strings.
const ptime = (v) => new Date(v && typeof v === 'object' ? (v.time ?? v.timep) : v);

// Open rounds: active, inside their window. (Client clock is display-only —
// the contract enforces the real window and budget on every claim.)
async function fetchOpenRounds() {
  const ids = await local(`(${C}.round-ids)`);
  const rounds = [];
  for (const id of ids) {
    const r = await local(`(${C}.get-round "${id}")`);
    const now = new Date();
    if (r.active && now >= ptime(r.opens) && now < ptime(r.closes)
        && num(r.claimed) + num(r.amount) <= num(r.budget)) {
      rounds.push({ id, amount: num(r.amount), closes: ptime(r.closes) });
    }
  }
  return rounds;
}

function selectedRound() {
  const sel = $('round');
  return state.rounds.find((r) => r.id === sel.value) ?? state.rounds[0];
}

async function refresh() {
  const key = loadKey();
  $('account').textContent = key.account;
  try {
    state.station = state.station ?? (await local(`(${G}.station-account)`));
    const [open, pool, bal, rounds] = await Promise.all([
      local(`(at 'open (${C}.get-config))`),
      local(`(${C}.pool-balance)`),
      local(`(${T}.get-balance "${key.account}")`).catch(() => 0),
      fetchOpenRounds(),
    ]);
    state.rounds = open ? rounds : [];
    const sel = $('round');
    const keep = sel.value;
    sel.innerHTML = '';
    for (const r of state.rounds) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = `${r.id} — ${r.amount} PCO (until ${r.closes.toISOString().slice(0, 10)})`;
      sel.appendChild(o);
    }
    if (state.rounds.some((r) => r.id === keep)) sel.value = keep;
    $('claim-state').textContent = !open ? 'CLOSED'
      : state.rounds.length ? `${state.rounds.length} open round${state.rounds.length > 1 ? 's' : ''}` : 'no open rounds';
    $('pool').textContent = `${num(pool).toLocaleString()} PCO left in the pool`;
    $('balance').textContent = `${num(bal).toLocaleString()} PCO (this browser key)`;
    const round = selectedRound();
    let already = false;
    if (round) already = await local(`(${C}.claimed "${round.id}" "${key.account}")`);
    $('claim-btn').disabled = !open || !round || already;
    $('claim-btn').textContent = round ? `claim ${round.amount} PCO` : 'claim';

    // The wallet is the actor for the non-sponsored actions (send / x-send).
    // There is NO balance threshold on this page: holding PCO grants no right
    // to open a proposal, because holders cannot open one at all.
    const w = state.wallet;
    const wbal = w ? num(await local(`(${T}.get-balance "${w.account}")`).catch(() => 0)) : 0;
    $('wallet-balance').textContent = w ? `${wbal.toLocaleString()} PCO` : '—';
    renderWallet();

    if (already && Date.now() - state.lastAction > 8000)
      setStatus(`This account already claimed round "${round.id}". One claim per account per round.`, 'info');
  } catch (e) {
    setStatus(`Cannot reach the network: ${e.message}`, 'err');
  }
}

async function claim() {
  const key = loadKey();
  const round = selectedRound();
  const code = $('code').value.trim().toLowerCase();
  if (!round) { setStatus('No open round to claim right now.', 'err'); return; }
  if (!code) { setStatus('Enter the engagement code first.', 'err'); return; }
  $('claim-btn').disabled = true;
  setStatus(`Submitting your "${round.id}" claim (the PCO gas station pays the fee)…`);
  try {
    const r = await sponsored(
      `(${C}.claim "${round.id}" "${key.account}" (read-keyset 'ks) "${code}")`,
      [],
      { ks: { keys: [key.pub], pred: 'keys-all' } },
    );
    setStatus(`Claimed! Transaction ${r.reqKey ?? ''} confirmed.`, 'ok');
  } catch (e) {
    setStatus(`Claim failed: ${e.message}`, 'err');
  }
  await refresh();
}

const AMOUNT_RE = /^\d+(\.\d{1,12})?$/;

// direction: 'same' = same-chain transfer; 'x' = cross-chain to a target chain.
async function transfer(direction) {
  const w = state.wallet;
  if (!w) { setStatus('Connect a wallet to send PCO (transfers are not gas-sponsored).', 'err'); return; }
  const to = $('to').value.trim();
  const raw = $('amount').value.trim();
  if (!/^k:[0-9a-f]{64}$/.test(to)) {
    setStatus('Recipient must be a k: account (k: + 64 hex characters).', 'err'); return;
  }
  if (!AMOUNT_RE.test(raw) || Number(raw) <= 0) {
    setStatus('Amount must be a positive number (max 12 decimals).', 'err'); return;
  }
  const amt = raw.includes('.') ? raw : `${raw}.0`;
  const targetChain = $('x-chain').value.trim();
  if (direction === 'x') {
    if (!/^([0-9]|1[0-9])$/.test(targetChain) || targetChain === CFG.chain) {
      setStatus('Cross-chain: pick a target chain 0–19 that is not the current chain.', 'err'); return;
    }
  } else if (to === w.account) {
    setStatus('Same-chain transfer to your own account is a no-op.', 'err'); return;
  }
  $('transfer-btn').disabled = true; $('xtransfer-btn').disabled = true;
  setStatus(`Sending ${amt} PCO ${direction === 'x' ? `to chain ${targetChain}` : ''} (your wallet pays the gas)…`);
  try {
    if (direction === 'x') {
      await walletExec(
        `(${T}.transfer-crosschain "${w.account}" "${to}" (read-keyset 'rg) "${targetChain}" ${amt})`,
        [{ name: `${T}.TRANSFER_XCHAIN`, args: [w.account, to, { decimal: amt }, targetChain], description: `Cross-chain send ${amt} PCO` }],
        { rg: { keys: [to.slice(2)], pred: 'keys-all' } },
      );
      setStatus(`Cross-chain send started to chain ${targetChain}. The continuation completes on the target chain.`, 'ok');
    } else {
      await walletExec(
        `(${T}.transfer-create "${w.account}" "${to}" (read-keyset 'rg) ${amt})`,
        [{ name: `${T}.TRANSFER`, args: [w.account, to, { decimal: amt }], description: `Send ${amt} PCO` }],
        { rg: { keys: [to.slice(2)], pred: 'keys-all' } },
      );
      setStatus(`Sent ${amt} PCO to ${to.slice(0, 14)}…`, 'ok');
    }
    $('to').value = ''; $('amount').value = '';
  } catch (e) {
    setStatus(`Transfer failed: ${e.message}`, 'err');
  }
  $('transfer-btn').disabled = false; $('xtransfer-btn').disabled = false;
  await refresh();
}

function backupKey() {
  const key = loadKey();
  const blob = new Blob(
    [JSON.stringify({ account: key.account, publicKey: key.pub, secretKey: key.priv, note: 'PCO community token key. Keep private. Valueless token, but the key IS the account.' }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pco-key-backup.json';
  a.click();
}

function restoreKey() {
  const input = $('restore-file');
  input.onchange = () => {
    const f = input.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const j = JSON.parse(reader.result);
        const priv = j.secretKey, pub = j.publicKey;
        if (!/^[0-9a-f]{64}$/.test(priv || '') || !/^[0-9a-f]{64}$/.test(pub || ''))
          throw new Error('not a PCO key backup (need 64-hex secretKey + publicKey)');
        // integrity: the stored account must be the k: principal of the pubkey
        if (j.account && j.account !== `k:${pub}`)
          throw new Error('backup account does not match its public key');
        localStorage.setItem('pco-key', JSON.stringify({ priv, pub, account: `k:${pub}` }));
        setStatus(`Restored account k:${pub.slice(0, 12)}…`, 'ok');
        refresh();
      } catch (e) {
        setStatus(`Could not restore: ${e.message}`, 'err');
      }
      input.value = '';
    };
    reader.readAsText(f);
  };
  input.click();
}

$('claim-btn').onclick = claim;
$('round').onchange = refresh;
$('transfer-btn').onclick = () => transfer('same');
$('xtransfer-btn').onclick = () => transfer('x');
$('restore-btn').onclick = restoreKey;
$('backup-btn').onclick = backupKey;
$('connect-btn').onclick = connectWallet;
$('disconnect-btn').onclick = disconnectWallet;
$('net').textContent = `${CFG.networkId} · chain ${CFG.chain} · ${CFG.ns}`;
renderWallet();
refresh();
setInterval(refresh, 30000);
