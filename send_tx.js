const https = require('https');
const crypto = require('crypto');
const bs58 = require('bs58').default;
const nacl = require('tweetnacl');

const RPC = 'https://rpc.mainnet.near.org';
const ACCOUNT = '0c279aaeb803608f60bf8eac25a52570e4a32551f5feb854f0f0355f028760ed';
const PRIVATE_KEY = 'ed25519:5hBA7ZEzD8cZV2otawo2SfnUnvyf4PvoEzp8wNMx9xkF5Gy1p1wS9NwDLHJD3MNCLewxKcdjfRLKUmuBAiuUQj7a';

const pkBytes = bs58.decode(PRIVATE_KEY.split(':')[1]);
const secretKey = pkBytes;

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '2.0', id: '1', method, params });
    const req = https.request(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        const j = JSON.parse(body);
        if (j.error) reject(new Error(JSON.stringify(j.error)));
        else resolve(j.result);
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

class BorshWriter {
  constructor() { this.buf = Buffer.alloc(0); }
  write(buf) { this.buf = Buffer.concat([this.buf, buf]); }
  u8(v) { const b = Buffer.alloc(1); b.writeUInt8(v); this.write(b); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.write(b); }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.write(b); }
  u128(v) { const b = Buffer.alloc(16); const bn = BigInt(v); b.writeBigUInt64LE(bn & 0xFFFFFFFFFFFFFFFFn, 0); b.writeBigUInt64LE(bn >> 64n, 8); this.write(b); }
  string(s) { const b = Buffer.from(s, 'utf8'); this.u32(b.length); this.write(b); }
  publicKey(pk) { const raw = bs58.decode(pk.split(':')[1]); this.write(Buffer.from([0, ...raw.slice(0, 32)])); }
  signature(sig) { this.write(Bector.from([0, ...sig])); }
}

function serializeTransaction(signerId, publicKey, nonce, receiverId, actions, blockHash) {
  const w = new BorshWriter();
  w.string(signerId);
  w.publicKey(publicKey);
  w.u64(nonce);
  w.string(receiverId);
  w.u32(actions.length);
  for (const a of actions) {
    if (a.type === 'FunctionCall') { w.u8(2); w.string(a.methodName); const args = Buffer.from(a.args, 'utf8'); w.u32(args.length); w.write(args); w.u64(a.gas); w.u128(a.deposit); }
  }
  w.write(bs58.decode(blockHash));
  return w.buf;
}

function serializeSignedTransaction(signerId, publicKeyStr, nonce, receiverId, actions, blockHash, signatureBytes) {
  const innerTx = serializeTransaction(signerId, publicKeyStr, nonce, receiverId, actions, blockHash);
  const w = new BorshWriter();
  // ED25519 public key: 0x00 + 32 bytes
  const rawPk = bs58.decode(publicKeyStr.split(':')[1]);
  w.u8(0);
  w.write(rawPk.slice(0, 32));
  // ED25519 signature: 0x00 + 64 bytes
  w.u8(0);
  w.write(signatureBytes);
  // Inner transaction
  w.write(innerTx);
  return w.buf;
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }

async function getNonce() {
  const keys = await rpc('query', { request_type: 'view_access_key_list', finality: 'optimistic', account_id: ACCOUNT });
  const key = keys.keys.find(k => k.public_key === 'ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L');
  if (!key) throw new Error('Key not found');
  return key.access_key.nonce + 1;
}

async function getBlockHash() {
  const block = await rpc('block', { finality: 'final' });
  return block.header.hash;
}

async function sendTx(receiverId, actions, nonce_, blockHash_) {
  const nonce = nonce_ || await getNonce();
  const blockHash = blockHash_ || await getBlockHash();

  const txBytes = serializeTransaction(ACCOUNT, 'ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L', nonce, receiverId, actions, blockHash);
  const hash = sha256(txBytes);
  const signature = nacl.sign.detached(hash, secretKey);

  const signedTxBytes = serializeSignedTransaction(ACCOUNT, 'ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L', nonce, receiverId, actions, blockHash, signature);

  const txBase64 = Buffer.from(signedTxBytes).toString('base64');
  return await rpc('broadcast_tx_commit', [txBase64]);
}

async function main() {
  const action = process.argv[2];
  if (action === 'ft_transfer') {
    const receiverId = process.argv[3];
    const amount = process.argv[4];
    const memo = process.argv[5] || '';
    const nonce = await getNonce();
    const blockHash = await getBlockHash();
    console.log('Nonce:', nonce, 'Block:', blockHash);
    const result = await sendTx('wrap.near', [{ type: 'FunctionCall', methodName: 'ft_transfer', args: JSON.stringify({ receiver_id: receiverId, amount, memo }), gas: '30000000000000', deposit: '1' }], nonce, blockHash);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Usage: node send_tx.js ft_transfer <receiverId> <amount> [memo]');
  }
}

main().catch(e => console.error(e));
