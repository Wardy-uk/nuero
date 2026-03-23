// API base URL — uses VITE_API_URL in production, empty string (relative) in dev
export const API_BASE = import.meta.env.VITE_API_URL || '';

// Vault API key — included on vault requests to authenticate
const VAULT_API_KEY = import.meta.env.VITE_VAULT_API_KEY || '';

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// Fetch wrapper that automatically includes auth headers for vault routes
export function apiFetch(path, options = {}) {
  const url = apiUrl(path);
  const headers = { ...(options.headers || {}) };

  // Add vault API key for vault routes
  if (path.startsWith('/api/vault') && VAULT_API_KEY) {
    headers['X-Api-Key'] = VAULT_API_KEY;
  }

  return fetch(url, { ...options, headers });
}
