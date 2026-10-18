import {it,expect} from 'vitest';
import app from '../apps/control/src/worker';
import {AppEnv} from '../packages/core/src/security';
const env: Partial<AppEnv>={APP_ORIGIN:'https://gem.example',MCP_CLIENT_ID:'chatgpt',MCP_REDIRECT_URIS:'https://chatgpt.com/connector_platform_oauth_redirect'};
it('advertises separate OAuth issuer and protected MCP resource',async()=>{const r=await app.request('https://gem.example/.well-known/oauth-authorization-server',{},env);expect((await r.json<{code_challenge_methods_supported:string[]}>()).code_challenge_methods_supported).toEqual(['S256']);const p=await app.request('https://gem.example/.well-known/oauth-protected-resource/mcp',{},env);expect((await p.json<{resource:string}>()).resource).toBe('https://gem.example/mcp');});
it('rejects cross-origin browser writes before database access',async()=>{const r=await app.request('https://gem.example/api/logout',{method:'POST',headers:{Origin:'https://evil.example'}},env);expect(r.status).toBe(403);expect(await r.json()).toMatchObject({error:'invalid_origin'});});
it('requires app session for consent and does not accept Google bearer identity',async()=>{const r=await app.request('https://gem.example/oauth/authorize',{headers:{Authorization:'Bearer google-id-token'}},env);expect(r.status).toBe(401);});
