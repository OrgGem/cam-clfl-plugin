import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {LocalStore} from '../packages/local/src/store.js';
import {hash,dnsSchema} from '../packages/local/src/security.js';
it('serializes writers from separate store instances and persists only versioned metadata',async()=>{const dir=await mkdtemp(join(tmpdir(),'gem-store-'));try{const a=new LocalStore(dir),b=new LocalStore(dir);await Promise.all([a.transaction(async s=>{s.config.client_id='public-client';}),b.transaction(async s=>{s.config.scopes='openid';})]);expect((await a.read()).config).toEqual({client_id:'public-client',scopes:'openid'});if(process.platform!=='win32')expect((await stat(join(dir,'state.json'))).mode&0o777).toBe(0o600);expect(await readFile(join(dir,'state.json'),'utf8')).not.toContain('access_token');}finally{await rm(dir,{recursive:true,force:true});}});
it('rejects credential fields in the metadata format',async()=>{const dir=await mkdtemp(join(tmpdir(),'gem-store-'));try{const a=new LocalStore(dir);await expect(a.transaction(async s=>{Object.assign(s.config,{access_token:'secret'});})).rejects.toThrow();}finally{await rm(dir,{recursive:true,force:true});}});
it('uses S256 PKCE and validates DNS before approval',()=>{expect(hash('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');expect(dnsSchema.safeParse({type:'A',name:'test.example',content:'wrong',ttl:1}).success).toBe(false);});
