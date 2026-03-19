// API base URL — uses VITE_API_URL in production, empty string (relative) in dev
export const API_BASE = import.meta.env.VITE_API_URL || '';

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}
