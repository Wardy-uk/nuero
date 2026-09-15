import { randomUUID } from 'node:crypto';
import { BackendError } from './backend.js';

// Temporary response cache only, never a second brain. Original scope is enforced
// when reading every page. Writes are executed once, not repeated for pagination.
export function createResultStore(now = Date.now) {
  const cache = new Map(); const ttl = 5 * 60 * 1000; const maxBytes = 32 * 1024 * 1024;
  const prune = () => { for (const [id,v] of cache) if (v.expires <= now()) cache.delete(id); };
  return {
    put(data, scopes) {
      prune(); const text = JSON.stringify(data); const bytes = Buffer.byteLength(text);
      if (bytes > maxBytes) throw new BackendError('result_too_large');
      let used = [...cache.values()].reduce((n,v) => n+v.bytes,0);
      while (used + bytes > maxBytes || cache.size >= 30) { const id = cache.keys().next().value; used -= cache.get(id).bytes; cache.delete(id); }
      const id = randomUUID(); cache.set(id, { text, bytes, scopes, expires: now()+ttl }); return id;
    },
    get(id, scopes, offset = 0, length = 12000) {
      prune(); const value = cache.get(id);
      if (!value) throw new BackendError('result_expired_or_missing');
      if (value.scopes.some(s => !scopes.includes(s))) throw new BackendError('insufficient_scope');
      return { result_id: id, text: value.text.slice(offset,offset+length), encoding: 'json_text', offset, total_chars: value.text.length, next_offset: offset+length < value.text.length ? offset+length : null, expires_at: new Date(value.expires).toISOString() };
    },
  };
}
