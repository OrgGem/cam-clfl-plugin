import { z } from 'zod';
export class Fault extends Error { constructor(public status: number, public code: string) { super(code); } }
export const now = () => Math.floor(Date.now() / 1000);
export const opaque = () => crypto.randomUUID() + crypto.randomUUID();
export const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export const unb64 = (s: string) => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
export async function hash(s: string) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))); }
export async function seal(value: unknown, key: string, context: string) {
 const iv = crypto.getRandomValues(new Uint8Array(12));
 const k = await crypto.subtle.importKey('raw',unb64(key),'AES-GCM',false,['encrypt']);
 const data = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(context)},k,new TextEncoder().encode(JSON.stringify(value)));
 return `${b64(iv)}.${b64(new Uint8Array(data))}`;
}
export async function open(value: string, key: string, context: string): Promise<unknown> {
 const [iv,data] = value.split('.');
 const k = await crypto.subtle.importKey('raw',unb64(key),'AES-GCM',false,['decrypt']);
 return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:new TextEncoder().encode(context)},k,unb64(data))));
}
export const targetSchema = z.object({connection_id:z.string().uuid(),account_id:z.string().regex(/^[a-f0-9]{32}$/)}).strict();
export const zoneSchema = targetSchema.extend({zone_id:z.string().regex(/^[a-f0-9]{32}$/),page:z.number().int().min(1).max(1000).default(1)});
export const dnsSchema = z.object({type:z.enum(['A','AAAA','CNAME','TXT','MX']),name:z.string().min(1).max(253).transform(s=>s.toLowerCase().replace(/\.$/,'')),content:z.string().min(1).max(2048),ttl:z.number().int().refine(n=>n===1 || n>=60 && n<=86400),proxied:z.boolean().default(false),priority:z.number().int().min(0).max(65535).optional()}).strict().superRefine((v,c)=>{if(v.type==='MX' && v.priority===undefined)c.addIssue({code:'custom',message:'MX requires priority'});if(v.proxied && !['A','AAAA','CNAME'].includes(v.type))c.addIssue({code:'custom',message:'Type cannot be proxied'});});
export type Target = z.infer<typeof targetSchema>;
export function canonical(v: unknown): string { if(Array.isArray(v))return '['+v.map(canonical).join(',')+']'; if(v && typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';return JSON.stringify(v); }
export function recordShape(v: unknown) { const r=z.object({id:z.string().optional(),type:z.string(),name:z.string(),content:z.string(),ttl:z.number(),proxied:z.boolean().optional(),priority:z.number().optional(),modified_on:z.string().optional()}).parse(v); return r; }
export type AppEnv = { [K in keyof Env]: Env[K] extends string ? string : Env[K] } & {GOOGLE_CLIENT_SECRET:string; CF_CLIENT_SECRET:string; CREDENTIAL_KEYS:string};
export function encryptionKey(env: AppEnv, version: string) { const keys=z.record(z.string(),z.string()).parse(JSON.parse(env.CREDENTIAL_KEYS)); if(!keys[version])throw new Fault(503,'encryption_key_unavailable');return keys[version]; }
export async function audit(env: AppEnv, user: string, action: string, request: string, target?: Target, operation?: string, result='ok') {
 await env.DB.prepare('INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),user,action,target?.connection_id??null,target?.account_id??null,operation??null,result,request,now()).run();
}
export async function authorize(env: AppEnv, user: string, target: Target, permission='read') {
 const row=await env.DB.prepare(`SELECT a.*, c.owner_id, c.status FROM connection_accounts a JOIN cloudflare_connections c ON c.id=a.connection_id WHERE a.connection_id=? AND a.account_id=? AND c.status='active' AND (c.owner_id=? OR EXISTS (SELECT 1 FROM access_grants g WHERE g.user_id=? AND g.connection_id=a.connection_id AND g.account_id=a.account_id AND g.permission=?))`).bind(target.connection_id,target.account_id,user,user,permission).first<{owner_id:string;alias:string;environment:string;scopes:string}>();
 if(!row)throw new Fault(403,'target_not_authorized');
 if(row.owner_id!==user){
  const membership=await env.DB.prepare(`SELECT 1 FROM memberships actor JOIN memberships owner ON owner.workspace_id=actor.workspace_id WHERE actor.user_id=? AND owner.user_id=? AND (?='read' OR actor.role IN ('owner','admin','operator'))`).bind(user,row.owner_id,permission).first();
  if(!membership)throw new Fault(403,'workspace_role_not_authorized');
 }
 return row;
}
