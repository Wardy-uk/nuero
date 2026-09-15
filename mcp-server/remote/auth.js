import { createRemoteJWKSet, jwtVerify } from 'jose';

const fail = reason => Object.assign(new Error('Unauthorized'), { reason });

export function createVerifier(config, keys = createRemoteJWKSet(new URL(config.MCP_AUTH_JWKS_URL), { timeoutDuration: 5000 })) {
  return async token => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.MCP_AUTH_ISSUER, audience: config.MCP_PUBLIC_URL,
      algorithms: [config.MCP_AUTH_ALGORITHMS], requiredClaims: ['exp', 'iat', 'sub'],
      clockTolerance: 5, maxTokenAge: config.MCP_AUTH_MAX_TOKEN_AGE,
    });
    // A refusal that cannot say WHY is five different failures wearing one
    // face: no token, a bad signature, the wrong audience, an expired token,
    // the wrong person. The reason is a CATEGORY name and never carries a
    // claim value, a subject or any part of the token.
    if (payload.sub !== config.MCP_AUTH_SUBJECT) throw fail('subject_mismatch');
    if (typeof payload.scope !== 'string') throw fail('no_scope_claim');
    const scopes = payload.scope.split(' ');
    if (!scopes.includes('neuro:read')) throw fail('missing_neuro_read');
    return { scopes };
  };
}
