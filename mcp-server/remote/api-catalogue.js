import inventory from './api-inventory.json' with { type: 'json' };
import { z } from 'zod';
import { classify, interactive, aliases, scopesFor, paramEnums, notes } from './api-policy.js';
import { BackendError } from './backend.js';

export const operations = inventory.map(op => Object.freeze({ ...op, classification: classify(op), interactive: interactive[op.id] || null, adaptedRoute: aliases[op.id] || null, ...(notes[op.id] ? { description: `${op.description} ${notes[op.id]}` } : {}) }));
const index = new Map(operations.map(op => [op.id, op]));
const json = z.json();
const scalar = z.union([z.string().max(16000), z.number().finite(), z.boolean(), z.null()]);
const pathValue = z.union([z.string().min(1).max(1000), z.number().int()]).transform(String).refine(v => v !== '.' && v !== '..' && !/[\/\\\x00-\x1f]/.test(v), 'Expected one path segment');
const file = z.strictObject({ filename: z.string().min(1).max(180).refine(v => !/[\/\\\x00-\x1f]/.test(v)), mime_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/), base64: z.string().max(4 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) });

function safeInput(value, key = '', depth = 0) {
  if (depth > 20) throw new BackendError('input_too_deep');
  if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new BackendError('invalid_input_key');
  if (typeof value === 'string' && /^(path|dir|sourcePath|targetPath|fileName|filename|relativePath|folder|filePath|sourceDir|targetDir|person|personName|name|slug)$/i.test(key)) {
    if (/^[\/\\]|^[a-z]:|\x00/i.test(value) || value.replace(/\\/g, '/').split('/').includes('..')) throw new BackendError('invalid_relative_path');
  }
  if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) safeInput(v,k,depth + 1);
}
export function operationSchema(op) {
  return z.strictObject({
    params: z.strictObject(Object.fromEntries(op.params.map(key => [key, paramEnums[op.id]?.[key] ? z.enum(paramEnums[op.id][key]) : pathValue]))).default({}),
    query: (op.queryOpen ? z.record(z.string(), scalar) : z.strictObject(Object.fromEntries(op.query.map(key => [key, scalar.optional()])))).default({}),
    body: (op.bodyOpen ? json : z.strictObject(Object.fromEntries(op.body.map(key => [key, json.optional()])))).optional(),
    ...(op.multipart ? { file } : {}),
  });
}
export function bindOperation(id, input) {
  const op = index.get(id);
  if (!op) throw new BackendError('unknown_operation');
  const parsed = operationSchema(op).parse(input);
  safeInput(parsed);
  // Authentication is injected from server secrets, never selected by a model.
  for (const key of Object.keys(parsed.query)) if (/^(pin|api_key|api_token|access_token|authorization)$/i.test(key)) throw new BackendError('credentials_not_allowed_in_query');
  let route = op.adaptedRoute || op.route;
  for (const key of op.params) route = route.replace(`:${key}`, encodeURIComponent(parsed.params[key]));
  const query = new URLSearchParams(Object.entries(parsed.query).filter(([,v]) => v != null).map(([k,v]) => [k,String(v)])).toString();
  if (query) route += `?${query}`;
  return { op, route, body: parsed.body, file: parsed.file };
}

const requestShape = {
  operation: z.string(), params: z.record(z.string(), z.union([z.string(), z.number().int()])).optional(),
  query: z.record(z.string(), scalar).optional(), body: json.optional(), file: file.optional(),
};
const resultOutput = z.object({ operation: z.string(), status: z.string(), result: json });

export function fullAccessTools(config, api, auth, store, redact) {
  const tools = [];
  tools.push({ name: 'neuro_capabilities', description: 'Discover the complete NEURO API capability catalogue. Search a domain or operation; describe=true returns request schemas. Includes browser-only integration steps. Call this before using a full-access tool.', input: z.strictObject({ query: z.string().max(200).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(15), describe: z.boolean().default(false) }), output: z.object({ total: z.number(), next_offset: z.number().nullable(), capabilities: z.array(json) }), write: false, run: async ({ query, offset, limit, describe }) => {
    const found = operations.filter(op => `${op.id} ${op.domain} ${op.description}`.toLowerCase().includes(query.toLowerCase()));
    return { total: found.length, next_offset: offset + limit < found.length ? offset + limit : null, capabilities: found.slice(offset,offset+limit).map(op => ({ operation: op.id, tool: `neuro_${op.classification}`, purpose: op.description, classification: op.classification, scopes: scopesFor(op.classification), interactive: op.interactive, ...(describe ? { input_schema: z.toJSONSchema(operationSchema(op), { io: 'input' }), backend_validation: 'Backend service validates domain fields; dynamic body schemas intentionally accept JSON.', route: op.route } : {}) })) };
  } });
  tools.push({ name: 'neuro_result_get', description: 'Read the next page of a full-access operation result without repeating the operation. Results expire after five minutes or capacity eviction; the original operation scopes are still required.', input: z.strictObject({ result_id: z.string().uuid(), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(16000).default(12000) }), output: z.object({ result_id: z.string(), text: z.string(), encoding: z.string(), offset: z.number(), total_chars: z.number(), next_offset: z.number().nullable(), expires_at: z.string() }), write: false, run: async ({ result_id, offset, length }) => store.get(result_id, auth.scopes, offset, length) });
  // ⚠ `operation` is a STRING here, not an enum of all 513 ids, and the reason is
  // discovery rather than taste. A client budgets how much tool schema it will
  // accept: ChatGPT took the first 24 tools of a 55.4KB catalogue and silently
  // dropped the rest, which is how five working VANTAGE tools came to be invisible
  // (measured 16 Sep 2026 — the four enums below were 22KB of that). The registry
  // is unchanged and still CLOSED: `bindOperation` refuses an id it does not hold,
  // and the classification check below refuses one belonging to another tier, so
  // nothing is validated less — the list simply stops being shipped to every client
  // on every connection when `neuro_capabilities` exists to answer exactly that.
  for (const kind of ['read','write','action','admin']) {
    const examples = operations.filter(op => op.classification === kind).slice(0, 3).map(op => op.id).join(', ');
    tools.push({ name: `neuro_${kind}`, description: `Execute a named NEURO ${kind} capability. Fixed registry only; no caller-supplied HTTP URL/method/headers. \`operation\` is an id from neuro_capabilities (e.g. ${examples}) — call that first rather than guessing; an unknown id is refused. ${kind === 'read' ? 'Retrieve any NEURO domain.' : 'Requires explicit user intent; external/destructive effects follow the named operation. Never automatically retry an uncertain outcome.'}`, input: z.strictObject({ ...requestShape, operation: z.string().min(1).max(120) }), output: resultOutput, write: kind !== 'read', classification: kind, scopes: scopesFor(kind), run: async ({ operation, ...input }) => {
      const bound = bindOperation(operation, Object.fromEntries(Object.entries(input).filter(([,v]) => v !== undefined)));
      if (bound.op.classification !== kind) throw new BackendError('wrong_operation_classification');
      if (scopesFor(kind).some(s => !auth.scopes.includes(s))) throw new BackendError('insufficient_scope');
      if (bound.op.interactive) return { operation, status: 'interactive_required', result: { instruction: bound.op.interactive } };
      const result = await api(bound.route, bound.body, { method: bound.op.method, extended: true, file: bound.file });
      const cleaned = redact(result);
      const id = store.put(cleaned, scopesFor(kind));
      return { operation, status: result.backend_ok === false ? 'backend_refused' : 'completed', result: store.get(id, auth.scopes) };
    } });
  }
  return tools;
}
// Shared with vantage-catalogue.js so a second upstream reuses the SAME input
// validation rather than a copy of it that can drift weaker.
export { json, scalar, pathValue, file, safeInput };
