const crypto = require('crypto');
const bs58 = require('bs58').default;
const nacl = require('tweetnacl');

const ED_PREFIX = 'ed25519:';

// Borsh helpers
function borshString(buf, s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([buf, len, b]);
}
function borshFixed(buf, arr) {
  return Buffer.concat([buf, Buffer.from(arr)]);
}
function borshOptionString(buf, s) {
  if (s === null || s === undefined) {
    return Buffer.concat([buf, Buffer.from([0])]);
  }
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([buf, Buffer.from([1]), len, b]);
}

function borshSerializeNep413(message, nonceBytes, recipient, callbackUrl) {
  let buf = Buffer.alloc(0);
  buf = borshString(buf, message);
  buf = borshFixed(buf, nonceBytes);
  buf = borshString(buf, recipient);
  buf = borshOptionString(buf, callbackUrl || null);
  // Prefix: u32 LE (2147484061 = 2^31 + 413 = 0x8000019D)
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(2147484061);
  return Buffer.concat([prefix, buf]);
}

function nep413Sign(message, nonceBase64, recipient, privateKeyBase58) {
  const sk = privateKeyBase58.startsWith(ED_PREFIX)
    ? bs58.decode(privateKeyBase58.slice(ED_PREFIX.length))
    : bs58.decode(privateKeyBase58);
  const nonceBytes = Buffer.from(nonceBase64, 'base64');
  const serialized = borshSerializeNep413(message, nonceBytes, recipient);
  const hash = crypto.createHash('sha256').update(serialized).digest();
  const signature = nacl.sign.detached(hash, sk);
  return ED_PREFIX + bs58.encode(Buffer.from(signature));
}

function generateNonce() {
  return Buffer.from(crypto.randomBytes(32)).toString('base64');
}

// HTTP helpers for submit/publish modes
function httpPost(url, data, hdrs = {}) {
  return new Promise((res, rej) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const b = typeof data === 'string' ? data : JSON.stringify(data);
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hdrs },
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res({ s: r.statusCode, d: JSON.parse(d) }); } catch(e) { res({ s: r.statusCode, d }); } });
    });
    req.on('error', rej);
    req.write(b);
    req.end();
  });
}

const args = process.argv.slice(2);
const [mode, ...rest] = args;

if (mode === 'sign') {
  const [message, nonce, recipient, privateKey] = rest;
  console.log(JSON.stringify({ signature: nep413Sign(message, nonce, recipient, privateKey) }));
  process.exit(0);
}

if (mode === 'gen-nonce') {
  console.log(generateNonce());
  process.exit(0);
}

if (mode === 'submit-intent') {
  const [message, nonce, recipient, privateKey, depositAddress] = rest;
  const sig = nep413Sign(message, nonce, recipient, privateKey);
  const JWT = process.env.NEAR_SWAP_JWT_TOKEN;
  const body = JSON.stringify({
    type: 'swap_transfer',
    signedData: {
      standard: 'nep413',
      payload: { message, nonce, recipient },
      public_key: 'ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L',
      signature: sig,
    },
  });
  (async () => {
    const result = await httpPost('https://1click.chaindefuser.com/v0/submit-intent', body, { 'Authorization': `Bearer ${JWT}` });
    console.log('submit-intent result:', JSON.stringify(result.d, null, 2));
    if (result.s === 200 || result.s === 201) {
      const intentHash = result.d?.intentHash;
      const relayerBody = JSON.stringify({
        id: 1, jsonrpc: '2.0', method: 'publish_intent',
        params: [{ quote_hashes: [], signed_data: { standard: 'nep413', payload: { message, nonce, recipient }, public_key: 'ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L', signature: sig } }],
      });
      const relayerResult = await httpPost('https://solver-relay-v2.chaindefuser.com/rpc', relayerBody, { 'X-API-Key': JWT });
      console.log('relayer result:', JSON.stringify(relayerResult.d, null, 2));
      if (depositAddress && intentHash) {
        const depResult = await httpPost('https://1click.chaindefuser.com/v0/deposit/submit', JSON.stringify({ txHash: intentHash, depositAddress }), { 'Authorization': `Bearer ${JWT}` });
        console.log('deposit/submit result:', JSON.stringify(depResult.d, null, 2));
      }
    }
  })().catch(e => console.error(e));
  return;
}

if (mode === 'publish-relayer') {
  const [message, nonce, recipient, privateKey] = rest;
  const sig = nep413Sign(message, nonce, recipient, privateKey);
  const JWT = process.env.NEAR_SWAP_JWT_TOKEN;
  const body = JSON.stringify({
    id: 1, jsonrpc: '2.0', method: 'publish_intent',
    params: [{ quote_hashes: [], signed_data: { standard: 'nep413', payload: { message, nonce, recipient }, public_key: 'ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L', signature: sig } }],
  });
  (async () => {
    const result = await httpPost('https://solver-relay-v2.chaindefuser.com/rpc', body, { 'X-API-Key': JWT });
    console.log(JSON.stringify(result.d, null, 2));
  })().catch(e => console.error(e));
  return;
}

console.log('Usage: node nep413_sign.js <sign|gen-nonce|submit-intent|publish-relayer> ...');
