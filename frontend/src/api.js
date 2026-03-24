// API base URL — uses VITE_API_URL in production, empty string (relative) in dev
export const API_BASE = import.meta.env.VITE_API_URL || '';

// Vault API key — included on vault requests to authenticate
const VAULT_API_KEY = import.meta.env.VITE_VAULT_API_KEY || '';

// App PIN — stored in localStorage after login
const PIN_KEY = 'neuro_pin';

export function getPin() {
  try { return localStorage.getItem(PIN_KEY) || ''; }
  catch { return ''; }
}

export function setPin(pin) {
  try { localStorage.setItem(PIN_KEY, pin); }
  catch {}
}

export function clearPin() {
  try { localStorage.removeItem(PIN_KEY); }
  catch {}
}

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// Install global fetch interceptor — adds PIN to all API requests
const _originalFetch = window.fetch;
window.fetch = function(input, init = {}) {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (url.includes('/api/') && !url.includes('/api/auth/')) {
    const headers = new Headers(init.headers || {});
    const pin = getPin();
    if (pin && !headers.has('X-Neuro-Pin')) headers.set('X-Neuro-Pin', pin);
    init = { ...init, headers };
  }
  return _originalFetch.call(window, input, init);
};

// Fetch wrapper — includes PIN auth + vault API key
export function apiFetch(path, options = {}) {
  const url = apiUrl(path);
  const headers = { ...(options.headers || {}) };

  // Always include PIN
  const pin = getPin();
  if (pin) headers['X-Neuro-Pin'] = pin;

  // Add vault API key for vault routes
  if (path.startsWith('/api/vault') && VAULT_API_KEY) {
    headers['X-Api-Key'] = VAULT_API_KEY;
  }

  return fetch(url, { ...options, headers });
}
