import { createRemoteJWKSet, jwtVerify } from 'jose';

export function createVerifier(config, keys = createRemoteJWKSet(new URL(config.MCP_AUTH_JWKS_URL), { timeoutDuration: 5000 })) {
  return async token => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.MCP_AUTH_ISSUER, audience: config.MCP_PUBLIC_URL,
      algorithms: [config.MCP_AUTH_ALGORITHMS], requiredClaims: ['exp', 'iat', 'sub'],
      clockTolerance: 5, maxTokenAge: config.MCP_AUTH_MAX_TOKEN_AGE,
    });
    if (payload.sub !== config.MCP_AUTH_SUBJECT || typeof payload.scope !== 'string') throw new Error('Unauthorized');
    const scopes = payload.scope.split(' ');
    if (!scopes.includes('neuro:read')) throw new Error('Unauthorized');
    return { scopes };
  };
}
