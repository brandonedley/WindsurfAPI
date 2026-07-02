import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { fetchSelfDevinSessionToken, isDevinSessionToken } from './devin-session-token.js';

export const DEFAULT_DEVIN_WEBAPP_HOST = 'app.devin.ai';
export const DEFAULT_ACP_PROTOCOL_VERSION = 1;

export class DevinCloudAcpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DevinCloudAcpError';
    if (options.cause) this.cause = options.cause;
    if (options.code) this.code = options.code;
    if (options.data !== undefined) this.data = options.data;
  }
}

export function buildDevinCloudAcpUrl(sessionToken, options = {}) {
  if (!isDevinSessionToken(sessionToken)) {
    throw new DevinCloudAcpError('A Devin session token with devin- prefix is required for cloud ACP');
  }

  const rawBaseUrl = options.registryWebsocketUrl || process.env.DEVIN_CLOUD_ACP_URL || `wss://${DEFAULT_DEVIN_WEBAPP_HOST}/api/acp/live`;
  const url = new URL(rawBaseUrl);
  const rawHost = (options.webappHost || process.env.DEVIN_WEBAPP_HOST || url.host)
    .replace(/^https?:\/\//, '')
    .replace(/^wss?:\/\//, '')
    .replace(/\/+$/, '');
  url.host = rawHost;
  url.protocol = rawHost.startsWith('localhost') || rawHost.startsWith('127.0.0.1') ? 'ws:' : 'wss:';
  // Desktop strips DEVIN_SESSION_TOKEN_PREFIX before adding the query param.
  // The websocket endpoint expects the inner bearer value, not the display prefix.
  const queryToken = options.stripTokenPrefix === false ? sessionToken : sessionToken.slice('devin-'.length);
  url.searchParams.set('token', queryToken);
  return url.toString();
}

export function redactTokenFromUrl(url) {
  const parsed = new URL(url);
  if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '<redacted>');
  return parsed.toString();
}

export function buildInitializeRequest(options = {}) {
  return {
    jsonrpc: '2.0',
    id: options.id || 1,
    method: 'initialize',
    params: {
      protocolVersion: options.protocolVersion ?? DEFAULT_ACP_PROTOCOL_VERSION,
      clientInfo: {
        name: 'windsurf-api-lab',
        title: 'WindsurfAPI Lab',
        version: options.clientVersion || process.env.npm_package_version || '0.0.0',
      },
      clientCapabilities: {
        auth: { terminal: false },
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    },
  };
}

function summarizeInitializeResult(result) {
  return {
    protocolVersion: result?.protocolVersion,
    agentName: result?.agentInfo?.name,
    agentTitle: result?.agentInfo?.title,
    agentVersion: result?.agentInfo?.version,
    authMethodCount: Array.isArray(result?.authMethods) ? result.authMethods.length : 0,
    hasSessionCapabilities: !!result?.agentCapabilities?.sessionCapabilities,
    promptCapabilities: result?.agentCapabilities?.promptCapabilities || null,
  };
}

function waitForOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new DevinCloudAcpError(`WebSocket open timed out after ${timeoutMs}ms`, { code: 'ERR_WS_OPEN_TIMEOUT' }));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
      ws.removeEventListener?.('close', onClose);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (event) => {
      cleanup();
      reject(new DevinCloudAcpError('WebSocket error before open', { code: 'ERR_WS_OPEN_ERROR', data: event?.message }));
    };
    const onClose = (event) => {
      cleanup();
      reject(new DevinCloudAcpError(`WebSocket closed before open: ${event?.code || 0} ${event?.reason || ''}`.trim(), { code: 'ERR_WS_CLOSED_BEFORE_OPEN' }));
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', onClose, { once: true });
  });
}

function probeWebSocketUpgrade(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'ws:' ? http : https;
    const key = crypto.randomBytes(16).toString('base64');
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'ws:' ? 80 : 443),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        Host: parsed.host,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ upgraded: true, statusCode: res.statusCode, statusMessage: res.statusMessage });
    });
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve({
        upgraded: false,
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        cache: res.headers['x-cache'],
        cloudfrontPop: res.headers['x-amz-cf-pop'],
        contentType: res.headers['content-type'],
      }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ upgraded: false, error: `upgrade probe timed out after ${timeoutMs}ms` });
    });
    req.on('error', (err) => resolve({ upgraded: false, error: err.message }));
    req.end();
  });
}

function sendJson(ws, message) {
  ws.send(JSON.stringify(message));
}

function waitForResponse(ws, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const observedNotifications = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new DevinCloudAcpError(`ACP initialize response timed out after ${timeoutMs}ms`, {
        code: 'ERR_ACP_RESPONSE_TIMEOUT',
        data: { observedNotifications },
      }));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener?.('message', onMessage);
      ws.removeEventListener?.('error', onError);
      ws.removeEventListener?.('close', onClose);
    };
    const onMessage = (event) => {
      let payload;
      try {
        payload = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      } catch {
        payload = String(event.data);
      }
      let message;
      try {
        message = JSON.parse(payload);
      } catch (err) {
        cleanup();
        reject(new DevinCloudAcpError('Received non-JSON ACP websocket message', { code: 'ERR_ACP_BAD_JSON', cause: err }));
        return;
      }
      if (message?.method && message.id === undefined) {
        observedNotifications.push(message.method);
        return;
      }
      if (message?.id !== id) return;
      cleanup();
      if (message.error) {
        reject(new DevinCloudAcpError(`ACP initialize failed: ${message.error.message || 'unknown error'}`, {
          code: message.error.code || 'ERR_ACP_INITIALIZE',
          data: message.error.data,
        }));
      } else {
        resolve({ result: message.result, observedNotifications });
      }
    };
    const onError = (event) => {
      cleanup();
      reject(new DevinCloudAcpError('WebSocket error waiting for ACP response', { code: 'ERR_WS_RESPONSE_ERROR', data: event?.message }));
    };
    const onClose = (event) => {
      cleanup();
      reject(new DevinCloudAcpError(`WebSocket closed before ACP response: ${event?.code || 0} ${event?.reason || ''}`.trim(), { code: 'ERR_WS_CLOSED_BEFORE_RESPONSE' }));
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', onClose, { once: true });
  });
}

export async function runDevinCloudAcpInitializeSmoke(apiKeyOrToken, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  if (typeof WebSocketImpl !== 'function') {
    throw new DevinCloudAcpError('WebSocket is not available in this Node runtime');
  }

  const openTimeoutMs = options.openTimeoutMs || 15000;
  const responseTimeoutMs = options.responseTimeoutMs || 15000;
  const sessionToken = isDevinSessionToken(apiKeyOrToken)
    ? apiKeyOrToken
    : await fetchSelfDevinSessionToken(apiKeyOrToken, options);
  const url = buildDevinCloudAcpUrl(sessionToken, options);
  const ws = new WebSocketImpl(url);
  const initializeRequest = buildInitializeRequest(options);
  let opened = false;
  let closed = false;

  try {
    await waitForOpen(ws, openTimeoutMs);
    opened = true;
    const responsePromise = waitForResponse(ws, initializeRequest.id, responseTimeoutMs);
    sendJson(ws, initializeRequest);
    const { result, observedNotifications } = await responsePromise;
    try { ws.close(1000, 'handshake-smoke-complete'); } catch {}
    closed = true;
    return {
      ok: true,
      url: redactTokenFromUrl(url),
      tokenPrefixOk: isDevinSessionToken(sessionToken),
      tokenLength: sessionToken.length,
      opened,
      closed,
      sentInitialize: true,
      sentPrompt: false,
      createdSession: false,
      observedNotifications,
      initialize: summarizeInitializeResult(result),
    };
  } catch (err) {
    try { ws.close?.(1000, 'handshake-smoke-error'); } catch {}
    if (options.includeUpgradeProbe !== false && err instanceof DevinCloudAcpError && err.code === 'ERR_WS_OPEN_ERROR') {
      err.data = {
        websocketError: err.data,
        upgradeProbe: await probeWebSocketUpgrade(url, Math.min(openTimeoutMs, 5000)),
        url: redactTokenFromUrl(url),
      };
    }
    throw err;
  }
}
