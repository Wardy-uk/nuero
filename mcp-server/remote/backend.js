export class BackendError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Never forward MCP credentials, arbitrary URLs, or upstream error bodies.
// `target` names ONE upstream and owns its credential; the transport rules below
// (deadline, no redirects, size ceiling, safe error codes) are shared, so a second
// upstream cannot quietly be given weaker ones.
function createUpstream(config, target) {
  return async (route, body, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.MCP_UPSTREAM_TIMEOUT_MS);
    try {
      const method = options.method || (body === undefined ? 'GET' : 'POST');
      let payload = body === undefined ? undefined : JSON.stringify(body);
      if (options.file) {
        const form = new FormData();
        for (const [k,v] of Object.entries(body || {})) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
        form.append('file', new Blob([Buffer.from(options.file.base64, 'base64')], { type: options.file.mime_type }), options.file.filename);
        payload = form;
      }
      const response = await fetch(`${target.baseUrl.replace(/\/$/, '')}${route}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          ...(!options.file ? { 'Content-Type': 'application/json' } : {}),
          ...target.headersFor(route),
        },
        body: method === 'GET' ? undefined : payload,
      });
      if (!response.ok) { await response.body?.cancel(); throw new BackendError(options.extended ? `backend_http_${response.status}` : 'backend_unavailable'); }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > (options.extended ? 8 : 1) * 1024 * 1024) { controller.abort(); throw new BackendError('backend_response_too_large'); }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const mime = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
      if (options.extended) {
        if (!buffer.length) return { format: 'empty', data: null };
        if (/json/.test(mime)) {
          const data = JSON.parse(buffer.toString('utf8'));
          return { format: 'json', data, backend_ok: data?.ok !== false && data?.success !== false };
        }
        return { format: mime, encoding: /^text\//.test(mime) ? 'utf8' : 'base64', data: buffer.toString(/^text\//.test(mime) ? 'utf8' : 'base64') };
      }
      const data = JSON.parse(buffer.toString('utf8'));
      if (!data || typeof data !== 'object' || data.ok === false || data.success === false) throw new BackendError('backend_unavailable');
      return data;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError(controller.signal.aborted ? 'backend_timeout' : 'backend_unavailable');
    } finally { clearTimeout(timer); }
  };
}

export function createBackend(config) {
  const upstream = createUpstream(config, {
    baseUrl: config.NEURO_API_URL,
    headersFor: route => {
      const dnd = route.startsWith('/api/vault-dnd');
      const guest = /^\/api\/(v|c)\//.test(route);
      return {
        ...(config.NEURO_API_TOKEN ? { 'X-Neuro-Api-Token': config.NEURO_API_TOKEN } : { 'X-Neuro-Pin': config.NEURO_PIN }),
        ...(route.startsWith('/api/vault/') || route === '/api/vault' ? { 'X-Api-Key': config.NEURO_VAULT_KEY } : {}),
        ...(dnd ? { 'X-Api-Key': config.NEURO_DND_VAULT_KEY } : {}),
        ...(guest ? { Authorization: `Bearer ${config.NEURO_CAPTURE_SESSION}` } : {}),
      };
    },
  });
  return async (route, body, options = {}) => {
    if (/^\/api\/(v|c)\//.test(route) && !config.NEURO_CAPTURE_SESSION) throw new BackendError('capture_session_not_configured');
    if (route.startsWith('/api/vault-dnd') && !config.NEURO_DND_VAULT_KEY) throw new BackendError('dnd_vault_key_not_configured');
    return upstream(route, body, options);
  };
}

// VANTAGE has one credential, a PIN, in a header. It is refused BEFORE the network
// when unset — "the gateway was never told the PIN" needs a different fix from
// "VANTAGE is down", and a 401 would read as the latter.
export function createVantageBackend(config) {
  const upstream = createUpstream(config, {
    baseUrl: config.VANTAGE_API_URL,
    headersFor: () => ({ 'X-Vantage-Pin': config.VANTAGE_PIN }),
  });
  return async (route, body, options = {}) => {
    if (!config.VANTAGE_PIN) throw new BackendError('vantage_not_configured');
    return upstream(route, body, options);
  };
}
