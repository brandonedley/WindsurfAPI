// @ts-nocheck
export function parseUpstreamRetryAfterMs(message) {
  const text = String(message?.message || message || '');
  if (!text) return null;

  const english = text.match(/resets?\s+in\s*:\s*(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (english) {
    const h = Number(english[1] || 0);
    const m = Number(english[2] || 0);
    const s = Number(english[3] || 0);
    const ms = ((h * 3600) + (m * 60) + s) * 1000;
    return ms > 0 ? ms : null;
  }

  const seconds = text.match(/(?:请\s*)?(\d+)\s*秒(?:后)?(?:重试|再试)?/);
  if (seconds) return Number(seconds[1]) * 1000;

  const tryAgain = text.match(/try again (?:in|after)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)/i);
  if (tryAgain) {
    const n = Number(tryAgain[1]);
    const unit = tryAgain[2].toLowerCase();
    if (unit.startsWith('h')) return n * 3600 * 1000;
    if (unit.startsWith('m')) return n * 60 * 1000;
    return n * 1000;
  }

  return null;
}

export function buildOpenAIRateLimitError({ model = '', retryAfterMs = null, message = null } = {}) {
  const retrySeconds = Math.max(1, Math.ceil((retryAfterMs || 60_000) / 1000));
  return {
    status: 429,
    headers: { 'retry-after': String(retrySeconds), 'Retry-After': String(retrySeconds) },
    body: {
      error: {
        message: message || `${model || 'Model'} is temporarily rate-limited. Retry after ${retrySeconds}s.`,
        type: 'rate_limit',
        code: 'model_rate_limited',
        retry_after: retrySeconds,
      },
    },
  };
}
