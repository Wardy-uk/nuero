import inventory from './vantage-inventory.json' with { type: 'json' };
import { z } from 'zod';
import { json, scalar, pathValue, safeInput } from './api-catalogue.js';
import { scopesFor } from './api-policy.js';
import { classification, actionQuery, privateOperations, paramEnums, notes, bodySchemas, noBody } from './vantage-policy.js';
import { BackendError } from './backend.js';

// VANTAGE is DEPARTMENTAL and DIRECTIVE (the service desk: findings, the Support
// Review plan, coaching); NEURO is INBOUND and PERSONAL. They are separate tools
// on purpose — one `neuro_*` registry answering for both would let a model mistake
// a VANTAGE finding for a NEURO task, the confusion NEURO's CLAUDE.md spends a
// whole section warning about.
export const vantageOperations = inventory.map(op => Object.freeze({
  ...op,
  classification: classification[op.id] || null,
  private: privateOperations.has(op.id),
  ...(notes[op.id] ? { description: `${op.description} ${notes[op.id]}` } : {}),
}));
const index = new Map(vantageOperations.map(op => [op.id, op]));

export function vantageSchema(op) {
  return z.strictObject({
    params: z.strictObject(Object.fromEntries(op.params.map(key => [key, paramEnums[op.id]?.[key] ? z.enum(paramEnums[op.id][key]) : pathValue]))).default({}),
    query: z.strictObject(Object.fromEntries(op.query.map(key => [key, scalar.optional()]))).default({}),
    // A transcribed contract wins over the inventory's "arbitrary JSON"; a route
    // that reads no body advertises none rather than inviting an ignored payload.
    ...(noBody.has(op.id) ? {} : { body: (bodySchemas[op.id] || (op.bodyOpen ? json : z.strictObject(Object.fromEntries(op.body.map(key => [key, json.optional()]))))).optional() }),
  });
}

const switchedOn = (op, query) => (actionQuery[op.id] || []).some(k => query[k] != null && query[k] !== false && query[k] !== '0' && query[k] !== 0);

export function bindVantage(id, input, kind) {
  const op = index.get(id);
  if (!op || !op.classification) throw new BackendError('unknown_operation');
  const parsed = vantageSchema(op).parse(input);
  safeInput(parsed);
  for (const key of Object.keys(parsed.query)) if (/^(pin|api_key|api_token|access_token|authorization)$/i.test(key)) throw new BackendError('credentials_not_allowed_in_query');
  // A refresh switch turns a GET into work (a NOVA pull, a model call). Asked for on
  // the read tool it is REFUSED, not dropped: a refresh that silently did not happen
  // reads exactly like stale data.
  const effective = switchedOn(op, parsed.query) ? 'action' : op.classification;
  if (kind && effective !== kind) throw new BackendError(effective === 'action' && op.classification === 'read' ? 'refresh_requires_vantage_action' : 'wrong_operation_classification');
  let route = op.route;
  for (const key of op.params) route = route.replace(`:${key}`, encodeURIComponent(parsed.params[key]));
  const query = new URLSearchParams(Object.entries(parsed.query).filter(([,v]) => v != null).map(([k,v]) => [k,String(v)])).toString();
  if (query) route += `?${query}`;
  return { op, route, body: parsed.body, effective };
}

const requestShape = {
  params: z.record(z.string(), z.union([z.string(), z.number().int()])).optional(),
  query: z.record(z.string(), scalar).optional(), body: json.optional(),
};
const resultOutput = z.object({ operation: z.string(), status: z.string(), result: json });

export function vantageTools(config, api, auth, store, redact) {
  const privateAllowed = config.VANTAGE_MCP_PRIVATE === 'true';
  const withheldReason = 'Private in VANTAGE (coach, brief, self, observations). Withheld from this gateway unless VANTAGE_MCP_PRIVATE=true is set by Nick.';
  const tools = [];
  tools.push({ name: 'vantage_capabilities', description: 'Discover VANTAGE, the service-desk improvement system: findings (things spotted going wrong on the desk), the Support Review improvement plan, radar and NOVA signals, and coaching. Separate from NEURO — a VANTAGE finding is not a NEURO task until something routes it. describe=true returns request schemas. Large results page with neuro_result_get.', input: z.strictObject({ query: z.string().max(200).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(15), describe: z.boolean().default(false) }), output: z.object({ configured: z.boolean(), private_available: z.boolean(), total: z.number(), next_offset: z.number().nullable(), capabilities: z.array(json) }), write: false, run: async ({ query, offset, limit, describe }) => {
    const found = vantageOperations.filter(op => `${op.id} ${op.domain} ${op.description}`.toLowerCase().includes(query.toLowerCase()));
    return { configured: Boolean(config.VANTAGE_PIN), private_available: privateAllowed, total: found.length, next_offset: offset + limit < found.length ? offset + limit : null, capabilities: found.slice(offset, offset + limit).map(op => ({
      operation: op.id, tool: `vantage_${op.classification}`, purpose: op.description, classification: op.classification, scopes: scopesFor(op.classification),
      withheld: op.private && !privateAllowed ? withheldReason : null,
      ...(actionQuery[op.id] ? { action_switches: { query: actionQuery[op.id], tool: 'vantage_action', scopes: scopesFor('action') } } : {}),
      ...(describe ? { input_schema: z.toJSONSchema(vantageSchema(op), { io: 'input' }), route: op.route } : {}),
    })) };
  } });
  for (const kind of ['read', 'write', 'action', 'admin']) {
    const names = vantageOperations.filter(op => op.classification === kind || (kind === 'action' && actionQuery[op.id])).map(op => op.id);
    tools.push({ name: `vantage_${kind}`, description: `Execute a named VANTAGE ${kind} capability from vantage_capabilities. Fixed registry only; no caller-supplied URL, method or headers. ${kind === 'read' ? 'Reads VANTAGE without changing anything; refresh/rematch switches need vantage_action.' : kind === 'action' ? 'Reaches NEURO, Microsoft Planner, NOVA or spends a model call — requires explicit user intent. Also runs refresh/rematch switches on VANTAGE reads. Never automatically retry an uncertain outcome.' : 'Requires explicit user intent. Never automatically retry an uncertain outcome.'}`, input: z.strictObject({ ...requestShape, operation: z.enum(names) }), output: resultOutput, write: kind !== 'read', classification: kind, scopes: scopesFor(kind), run: async ({ operation, ...input }) => {
      // Scope BEFORE input: a caller who may not do this at all gets one plain
      // refusal, rather than a schema critique of a payload that was never going
      // to be sent anywhere.
      if (scopesFor(kind).some(s => !auth.scopes.includes(s))) throw new BackendError('insufficient_scope');
      const bound = bindVantage(operation, Object.fromEntries(Object.entries(input).filter(([,v]) => v !== undefined)), kind);
      if (bound.op.private && !privateAllowed) return { operation, status: 'withheld', result: { reason: withheldReason } };
      const result = await api(bound.route, bound.body, { method: bound.op.method, extended: true });
      const id = store.put(redact(result), scopesFor(kind));
      return { operation, status: result.backend_ok === false ? 'backend_refused' : 'completed', result: store.get(id, auth.scopes) };
    } });
  }
  return tools;
}
