const https = require('https');
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');
function loadApiKey() {
  try {
    const e = fs.readFileSync(ENV_FILE, 'utf8');
    for (const l of e.split('\n')) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0 && t.slice(0, i).trim() === 'DEEPSEEK_API_KEY') return t.slice(i + 1).trim();
    }
  } catch(e) {}
  return process.env.DEEPSEEK_API_KEY;
}

const API_KEY = loadApiKey();
const API_URL = 'https://api.deepseek.com/v1/chat/completions';

function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(data);
    const u = new URL(url);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(b);
    req.end();
  });
}

async function chat(messages, opts = {}) {
  if (!API_KEY) return null;
  try {
    const r = await httpPost(API_URL, {
      model: opts.model || 'deepseek-chat',
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens || 500,
    });
    return r.choices?.[0]?.message?.content || null;
  } catch(e) { return null; }
}

function hasKey() { return !!API_KEY; }

module.exports = { chat, hasKey };
