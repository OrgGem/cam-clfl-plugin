import {z} from 'zod';
import {AppEnv,Fault,now,open,seal,encryptionKey,Target} from './security';
export const credentials = z.object({access_token:z.string(),refresh_token:z.string(),scope:z.string().default('')});
export type Credentials = z.infer<typeof credentials>;
const envelope=z.object({success:z.boolean(),result:z.unknown(),result_info:z.object({page:z.number().optional(),total_pages:z.number().optional(),count:z.number().optional()}).optional()});
export class Cloudflare {
 constructor(private token:string,private upstream:typeof fetch=fetch){}
 async call(path:string,method='GET',body?:unknown):Promise<{result:unknown;result_info?:unknown}> {
  if(!/^\/(accounts|zones|user)(\/|\?|$)/.test(path))throw new Fault(400,'invalid_api_path');
  let response:Response;
  try { response=await this.upstream('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)}); }
  catch {throw new Fault(502,method==='GET'?'upstream_unavailable':'write_outcome_uncertain');}
  if(response.status===429)throw new Fault(429,'cloudflare_rate_limited');
  if(response.status===401 || response.status===403)throw new Fault(403,'cloudflare_permission_denied');
  if(!response.ok)throw new Fault(502,method==='GET'?'cloudflare_request_failed':'write_outcome_uncertain');
  let parsed;try{parsed=envelope.parse(await response.json());}catch{throw new Fault(502,method==='GET'?'cloudflare_invalid_response':'write_outcome_uncertain');}
  if(!parsed.success)throw new Fault(502,method==='GET'?'cloudflare_request_failed':'write_outcome_uncertain');return parsed;
 }
 async zone(target:Target,zone:string) {const r=await this.call(`/zones/${zone}`);const v=z.object({account:z.object({id:z.string()})}).parse(r.result);if(v.account.id!==target.account_id)throw new Fault(403,'zone_account_mismatch');}
}
export async function client(env:AppEnv,id:string):Promise<Cloudflare> {
 const row=await env.DB.prepare('SELECT * FROM cloudflare_connections WHERE id=? AND status=\'active\'').bind(id).first<{credential:string;key_version:string;expires_at:number}>();
 if(!row)throw new Fault(403,'connection_unavailable');
 let token=credentials.parse(await open(row.credential,encryptionKey(env,row.key_version),id));
 if(row.expires_at<=now()+60){
  const lock=crypto.randomUUID();
  const claimed=await env.DB.prepare('UPDATE cloudflare_connections SET refresh_lock=?,refresh_until=? WHERE id=? AND status=\'active\' AND (refresh_until IS NULL OR refresh_until<?)').bind(lock,now()+30,id,now()).run();
  if(!claimed.meta.changes)throw new Fault(409,'refresh_in_progress_retry_later');
  // A crashed refresh may have rotated the token. Never automatically replay it.
  const latest=await env.DB.prepare('SELECT credential,key_version,expires_at FROM cloudflare_connections WHERE id=?').bind(id).first<typeof row>();
  try {
   if(latest && latest.expires_at>now()+60)token=credentials.parse(await open(latest.credential,encryptionKey(env,latest.key_version),id));
   else {
    await env.DB.prepare('UPDATE cloudflare_connections SET status=\'refreshing\' WHERE id=? AND refresh_lock=?').bind(id,lock).run();
    const response=await fetch('https://dash.cloudflare.com/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+btoa(env.CF_CLIENT_ID+':'+env.CF_CLIENT_SECRET)},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refresh_token}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Fault(401,'connection_requires_reauthentication');
    const result=z.object({access_token:z.string(),refresh_token:z.string(),expires_in:z.number(),scope:z.string().optional()}).parse(await response.json());
    token={access_token:result.access_token,refresh_token:result.refresh_token,scope:result.scope??token.scope};
    await env.DB.prepare('UPDATE cloudflare_connections SET credential=?,key_version=?,expires_at=?,status=\'active\' WHERE id=? AND refresh_lock=? AND status=\'refreshing\'').bind(await seal(token,encryptionKey(env,env.KEY_VERSION),id),env.KEY_VERSION,now()+result.expires_in,id,lock).run();
   }
  }catch {await env.DB.prepare('UPDATE cloudflare_connections SET status=\'reauth_required\' WHERE id=? AND refresh_lock=? AND status=\'refreshing\'').bind(id,lock).run();throw new Fault(401,'connection_requires_reauthentication');}
  finally {await env.DB.prepare('UPDATE cloudflare_connections SET refresh_lock=NULL,refresh_until=NULL WHERE id=? AND refresh_lock=?').bind(id,lock).run();}
 }
 return new Cloudflare(token.access_token);
}
