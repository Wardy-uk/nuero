import { z } from 'zod';

const httpsUrl = z.string().url().refine(v => {
  const u = new URL(v);
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
}, 'Must be a credential-free HTTPS URL');
const integer = (fallback, max) => z.coerce.number().int().min(1).max(max).default(fallback);
export function readConfig(env = process.env) {
  const config = z.object({
    MCP_HOST: z.string().default('127.0.0.1'),
    MCP_PORT: integer(3100, 65535),
    MCP_PUBLIC_URL: httpsUrl.refine(v => new URL(v).pathname === '/mcp', 'Use https://hostname/mcp'),
    MCP_AUTH_ISSUER: httpsUrl,
    MCP_AUTH_JWKS_URL: httpsUrl,
    MCP_AUTH_SUBJECT: z.string().min(1),
    MCP_AUTH_ALGORITHMS: z.enum(['RS256', 'ES256']).default('RS256'),
    MCP_AUTH_MAX_TOKEN_AGE: integer(3600, 86400),
    NEURO_API_URL: z.string().url().default('http://127.0.0.1:3001'),
    NEURO_API_TOKEN: z.string().default(''),
    NEURO_PIN: z.string().default(''),
    NEURO_VAULT_KEY: z.string().min(1),
    NEURO_DND_VAULT_KEY: z.string().default(''),
    NEURO_CAPTURE_SESSION: z.string().default(''),
    MCP_MEMORY_DIR: z.string().default('MCP Memories'),
    MCP_UPSTREAM_TIMEOUT_MS: integer(15000, 60000),
    MCP_RATE_LIMIT: integer(120, 10000),
    MCP_TRUST_PROXY: z.enum(['false', 'loopback', 'linklocal,uniquelocal']).default('false'),
    LOG_LEVEL: z.enum(['info', 'error', 'silent']).default('info'),
  }).parse({ ...env, NEURO_API_URL: env.NEURO_API_URL || env.NEURO_URL });
  if (!config.NEURO_API_TOKEN && !config.NEURO_PIN) throw new Error('NEURO_API_TOKEN or NEURO_PIN required');
  const upstream = new URL(config.NEURO_API_URL);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Invalid NEURO_API_URL');
  if (!/^[\w -]+(?:\/[\w -]+)*$/.test(config.MCP_MEMORY_DIR)) throw new Error('Invalid MCP_MEMORY_DIR');
  return Object.freeze(config);
}
