#!/usr/bin/env node
import { readFileSync } from 'fs';
import { fetchSelfDevinSessionToken, isDevinSessionToken } from '../src/devin-session-token.js';

function readDevinCredentials(path = '/home/brandon/.local/share/devin/credentials.toml') {
  try {
    const text = readFileSync(path, 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const creds = readDevinCredentials(process.env.DEVIN_CREDENTIALS_PATH);
// Prefer Devin Desktop's own credential file over generic WINDSURF_API_KEY.
// In this repo/operator shell, WINDSURF_API_KEY may be a gateway or stale test key;
// Desktop's exchange specifically uses the key persisted by Devin/Windsurf auth.
const apiKey = process.env.DEVIN_WINDSURF_API_KEY
  || creds.windsurf_api_key
  || process.env.WINDSURF_API_KEY;
const apiServerUrl = process.env.DEVIN_WINDSURF_API_SERVER_URL
  || creds.api_server_url
  || process.env.WINDSURF_API_SERVER_URL
  || 'https://server.codeium.com';

if (!apiKey) {
  console.error('missing Windsurf API key: set DEVIN_WINDSURF_API_KEY or provide ~/.local/share/devin/credentials.toml');
  process.exit(2);
}

try {
  const token = await fetchSelfDevinSessionToken(apiKey, { apiServerUrl });
  console.log(JSON.stringify({
    ok: true,
    apiServerUrl,
    tokenPrefixOk: isDevinSessionToken(token),
    tokenLength: token.length,
    sentPrompt: false,
    openedWebSocket: false,
  }, null, 2));
} catch (err) {
  console.error(JSON.stringify({
    ok: false,
    apiServerUrl,
    error: err?.message || String(err),
    status: err?.status,
    bodyPreview: err?.bodyPreview,
    sentPrompt: false,
    openedWebSocket: false,
  }, null, 2));
  process.exit(1);
}
