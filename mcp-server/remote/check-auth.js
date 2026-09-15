import assert from 'node:assert/strict';
import { readConfig } from './config.js';

// Public discovery only: never print a token, subject, or credential.
try {
  const config = readConfig();
  const issuer = config.MCP_AUTH_ISSUER;
  const response = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  assert.ok(response.ok);
  const metadata = await response.json();
  assert.equal(metadata.issuer, issuer);
  assert.ok(metadata.code_challenge_methods_supported?.includes('S256'));
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) assert.equal(new URL(metadata[key]).protocol, 'https:');
  assert.equal(metadata.jwks_uri, config.MCP_AUTH_JWKS_URL);
  const jwks = await fetch(config.MCP_AUTH_JWKS_URL, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  assert.ok(jwks.ok); assert.ok((await jwks.json()).keys?.length);
  console.log('PASS: issuer discovery, S256 PKCE, HTTPS endpoints and JWKS. Complete an interactive OAuth login to verify audience, subject and scopes.');
} catch {
  console.error('FAIL: OAuth preflight. Check configuration and provider discovery; no configuration values were logged.');
  process.exitCode = 1;
}
