#!/usr/bin/env node
import { readFileSync } from 'fs';
import { runDevinCloudAcpInitializeSmoke } from '../src/devin-cloud-acp.js';

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
const apiKeyOrToken = process.env.DEVIN_SESSION_TOKEN
  || process.env.DEVIN_WINDSURF_API_KEY
  || creds.windsurf_api_key
  || process.env.WINDSURF_API_KEY;
const apiServerUrl = process.env.DEVIN_WINDSURF_API_SERVER_URL
  || creds.api_server_url
  || process.env.WINDSURF_API_SERVER_URL
  || 'https://server.codeium.com';
const webappHost = process.env.DEVIN_WEBAPP_HOST || creds.webapp_host || 'app.devin.ai';

if (!apiKeyOrToken) {
  console.error('missing credential: set DEVIN_SESSION_TOKEN, DEVIN_WINDSURF_API_KEY, or provide ~/.local/share/devin/credentials.toml');
  process.exit(2);
}

try {
  const result = await runDevinCloudAcpInitializeSmoke(apiKeyOrToken, {
    apiServerUrl,
    webappHost,
    openTimeoutMs: Number(process.env.DEVIN_CLOUD_OPEN_TIMEOUT_MS || 15000),
    responseTimeoutMs: Number(process.env.DEVIN_CLOUD_RESPONSE_TIMEOUT_MS || 15000),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(JSON.stringify({
    ok: false,
    apiServerUrl,
    webappHost,
    error: err?.message || String(err),
    code: err?.code,
    data: err?.data,
    sentPrompt: false,
    createdSession: false,
  }, null, 2));
  process.exit(1);
}
