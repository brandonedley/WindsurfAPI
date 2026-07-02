import { buildMetadata } from './windsurf.js';
import { writeMessageField, parseFields, getField } from './proto.js';

export const DEVIN_SESSION_TOKEN_PREFIX = 'devin-';
export const DEFAULT_CODEIUM_API_SERVER_URL = 'https://server.codeium.com';
export const GET_SELF_DEVIN_SESSION_TOKEN_PATH = '/exa.seat_management_pb.SeatManagementService/GetSelfDevinSessionToken';

export class DevinSessionTokenError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DevinSessionTokenError';
    if (options.cause) this.cause = options.cause;
    if (options.status) this.status = options.status;
    if (options.bodyPreview) this.bodyPreview = options.bodyPreview;
  }
}

export function isDevinSessionToken(value) {
  return typeof value === 'string' && value.startsWith(DEVIN_SESSION_TOKEN_PREFIX);
}

export function buildGetSelfDevinSessionTokenRequest(apiKey, options = {}) {
  const metadata = buildMetadata(
    apiKey,
    options.clientVersion || process.env.WINDSURF_CLIENT_VERSION || '3.0.12',
    options.sessionId || null,
  );
  return writeMessageField(1, metadata);
}

export function parseGetSelfDevinSessionTokenResponse(payload) {
  const fields = parseFields(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  const sessionTokenField = getField(fields, 1, 2);
  const sessionToken = sessionTokenField?.value?.toString('utf8') || '';

  if (!sessionToken) {
    throw new DevinSessionTokenError('GetSelfDevinSessionToken returned an empty session_token field');
  }
  if (!isDevinSessionToken(sessionToken)) {
    throw new DevinSessionTokenError('GetSelfDevinSessionToken returned a token without the expected devin- prefix');
  }

  return sessionToken;
}

export async function fetchSelfDevinSessionToken(apiKey, options = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new DevinSessionTokenError('A non-empty Windsurf API key is required to mint a Devin session token');
  }

  if (isDevinSessionToken(apiKey)) return apiKey;

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new DevinSessionTokenError('fetch is not available in this Node runtime');
  }

  const baseUrl = (options.apiServerUrl || process.env.WINDSURF_API_SERVER_URL || DEFAULT_CODEIUM_API_SERVER_URL).replace(/\/+$/, '');
  const url = `${baseUrl}${GET_SELF_DEVIN_SESSION_TOKEN_PATH}`;
  const body = buildGetSelfDevinSessionTokenRequest(apiKey, options);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/proto',
        'Accept': 'application/proto',
        'User-Agent': options.userAgent || 'connect-es/2.0.0',
        'X-Api-Key': apiKey,
      },
      body,
    });
  } catch (err) {
    throw new DevinSessionTokenError('Failed to call GetSelfDevinSessionToken', { cause: err });
  }

  const payload = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new DevinSessionTokenError(`GetSelfDevinSessionToken failed with HTTP ${response.status}`, {
      status: response.status,
      bodyPreview: payload.toString('utf8', 0, Math.min(payload.length, 240)),
    });
  }

  try {
    return parseGetSelfDevinSessionTokenResponse(payload);
  } catch (err) {
    if (err instanceof DevinSessionTokenError) throw err;
    throw new DevinSessionTokenError('Failed to parse GetSelfDevinSessionToken response protobuf', { cause: err });
  }
}
