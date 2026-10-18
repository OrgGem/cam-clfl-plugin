import {z} from 'zod';
import {CoreEnv,Fault,Target,targetSchema,dnsSchema,authorize,now,canonical,recordShape,audit,hash} from './security';
import {client,Cloudflare} from './cloudflare';
export const previewSchema=targetSchema.extend({zone_id:z.string().regex(/^[a-f0-9]{32}$/),record_id:z.string().regex(/^[a-f0-9]{32}$/).optional(),record:dnsSchema,idempotency_key:z.string().uuid()}).strict();
type Operation={id:string;user_id:string;connection_id:string;account_id:string;zone_id:string;record_id:string|null;payload:string;before_json:string;status:string;expires_at:number;result:string|null;request_id:string};
export const operationSchema=z.object({operation_id:z.string().uuid()}).strict();
async function get(env:CoreEnv,user:string,id:string){const row=await env.DB.prepare('SELECT * FROM operations WHERE id=? AND user_id=?').bind(id,user).first<Operation>();if(!row)throw new Fault(404,'operation_not_found');await authorize(env,user,row,'dns:write');return row;}
function desired(row:Operation){return dnsSchema.parse(JSON.parse(row.payload));}
function sameRecord(value:unknown,payload:unknown){const r=recordShape(value);const p=dnsSchema.parse(payload);return Object.entries(p).every(([k,v])=>r[k as keyof typeof r]===v);}
async function snapshot(cf:Cloudflare,row:{zone_id:string;record_id?:string|null;payload:string}) {
 if(row.record_id)return recordShape((await cf.call(`/zones/${row.zone_id}/dns_records/${row.record_id}`)).result);
 const p=dnsSchema.parse(JSON.parse(row.payload));const r=await cf.call(`/zones/${row.zone_id}/dns_records?name=${encodeURIComponent(p.name)}&type=${p.type}&per_page=100`);const records=z.array(z.unknown()).parse(r.result).map(recordShape);if(records.length>=100)throw new Fault(409,'dns_snapshot_too_large');return records.sort((a,b)=>(a.id??'').localeCompare(b.id??''));
}
export async function preview(env:CoreEnv,user:string,input:unknown,request:string){
 const v=previewSchema.parse(input),payload=JSON.stringify(v.record);await authorize(env,user,v,'dns:write');
 const digest=await hash(canonical(v));const existing=await env.DB.prepare('SELECT operation_id,request_hash FROM operation_keys WHERE user_id=? AND idempotency_key=?').bind(user,v.idempotency_key).first<{operation_id:string;request_hash:string}>();if(existing){if(existing.request_hash!==digest)throw new Fault(409,'idempotency_payload_mismatch');return operationStatus(env,user,existing.operation_id);}
 const cf=await client(env,v.connection_id);await cf.zone(v,v.zone_id);const before=await snapshot(cf,{...v,payload});
 if(!v.record_id && z.array(z.unknown()).parse(before).length)throw new Fault(409,'record_already_exists_use_update');
 if(v.record_id){const old=recordShape(before);if(sameRecord(old,v.record))throw new Fault(409,'dns_change_is_noop');if(old.name!==v.record.name || old.type!==v.record.type)throw new Fault(400,'record_rename_or_type_change_requires_separate_flow');}
 const id=crypto.randomUUID();await authorize(env,user,v,'dns:write');
 await env.DB.batch([env.DB.prepare('INSERT INTO operations (id,user_id,connection_id,account_id,zone_id,record_id,payload,before_json,status,expires_at,created_at,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,user,v.connection_id,v.account_id,v.zone_id,v.record_id??null,payload,canonical(before),'pending',now()+600,now(),request),env.DB.prepare('INSERT INTO operation_keys VALUES (?,?,?,?)').bind(user,v.idempotency_key,id,digest)]);
 await audit(env,user,'dns.preview',request,v,id);return operationStatus(env,user,id);
}
export async function operationStatus(env:CoreEnv,user:string,id:string){const row=await get(env,user,id);const access=await authorize(env,user,row,'dns:write');return {operation_id:row.id,connection_id:row.connection_id,account_id:row.account_id,zone_id:row.zone_id,record_id:row.record_id,alias:access.alias,environment:access.environment,status:row.status,expires_at:row.expires_at,before:JSON.parse(row.before_json),after:desired(row),result:row.result?JSON.parse(row.result):null,request_id:row.request_id};}
export async function approve(env:CoreEnv,user:string,id:string,decision:'approve'|'reject',confirmation:string,request:string){
 const row=await get(env,user,id);const access=await authorize(env,user,row,'dns:write');if(row.expires_at<=now())throw new Fault(409,'approval_expired');if(row.status!=='pending')throw new Fault(409,'operation_not_pending');
 if(access.environment==='production' && confirmation!==`${row.connection_id}/${row.account_id}/${row.zone_id}`)throw new Fault(400,'production_target_confirmation_required');
 if(decision==='reject')await env.DB.prepare('UPDATE operations SET status=\'rejected\' WHERE id=? AND status=\'pending\'').bind(id).run();
 else await env.DB.batch([env.DB.prepare('INSERT INTO approvals (operation_id,user_id,approved_at) SELECT id,?,? FROM operations WHERE id=? AND status=\'pending\' AND expires_at>?').bind(user,now(),id,now()),env.DB.prepare('UPDATE operations SET status=\'approved\' WHERE id=? AND status=\'pending\' AND EXISTS (SELECT 1 FROM approvals WHERE operation_id=? AND user_id=?)').bind(id,id,user)]);
 await audit(env,user,'dns.'+decision,request,row,id);return operationStatus(env,user,id);
}
async function finish(env:CoreEnv,row:Operation,status:string,result:unknown,request:string){await env.DB.prepare('UPDATE operations SET status=?,result=? WHERE id=? AND status IN (\'applying\',\'uncertain\')').bind(status,JSON.stringify(result),row.id).run();await audit(env,row.user_id,'dns.'+status,request,row,row.id);}
async function verify(env:CoreEnv,row:Operation,cf:Cloudflare,request:string){
 try {const actual=await snapshot(cf,row);const match=row.record_id?sameRecord(actual,desired(row)):z.array(z.unknown()).parse(actual).length===1 && sameRecord(z.array(z.unknown()).parse(actual)[0],desired(row));if(match){await finish(env,row,'succeeded',{verified:true,record:actual},request);await env.DB.prepare('DELETE FROM dns_locks WHERE operation_id=?').bind(row.id).run();}else await finish(env,row,'uncertain',{verified:false,reason:'upstream_result_not_confirmed_do_not_retry_write'},request);}
 catch {await finish(env,row,'uncertain',{verified:false,reason:'verification_unavailable_do_not_retry_write'},request);}
 return operationStatus(env,row.user_id,row.id);
}
export async function apply(env:CoreEnv,user:string,id:string,request:string){
 const row=await get(env,user,id);if(row.status==='succeeded' || row.status==='conflict' || row.status==='failed' || row.status==='rejected')return operationStatus(env,user,id);
 const cf=await client(env,row.connection_id);await cf.zone(row,row.zone_id);
 // Replays only reconcile. They never issue another mutation, including after a crash.
 if(row.status==='applying' || row.status==='uncertain')return verify(env,row,cf,request);
 if(row.status!=='approved' || row.expires_at<=now())throw new Fault(409,'valid_approval_required');
 const p=desired(row),key=p.type+':'+p.name;
 await env.DB.prepare('INSERT OR IGNORE INTO dns_locks VALUES (?,?,?,?)').bind(row.account_id,row.zone_id,key,id).run();
 const lock=await env.DB.prepare('SELECT operation_id FROM dns_locks WHERE account_id=? AND zone_id=? AND record_key=?').bind(row.account_id,row.zone_id,key).first<{operation_id:string}>();if(lock?.operation_id!==id)throw new Fault(409,'dns_target_operation_in_progress');
 const claim=await env.DB.prepare(`UPDATE operations SET status='applying' WHERE id=? AND status='approved' AND expires_at>? AND EXISTS (SELECT 1 FROM approvals WHERE operation_id=? AND user_id=? AND consumed_at IS NULL) RETURNING id`).bind(id,now(),id,user).first();
 if(!claim)return operationStatus(env,user,id);
 await env.DB.prepare('UPDATE approvals SET consumed_at=? WHERE operation_id=? AND consumed_at IS NULL').bind(now(),id).run();
 try{
  await authorize(env,user,row,'dns:write');const current=await snapshot(cf,row);
  if(canonical(current)!==row.before_json){await finish(env,row,'conflict',{reason:'resource_changed_preview_again'},request);await env.DB.prepare('DELETE FROM dns_locks WHERE operation_id=?').bind(id).run();return operationStatus(env,user,id);}
  await authorize(env,user,row,'dns:write');
  try{await cf.call(`/zones/${row.zone_id}/dns_records${row.record_id?'/'+row.record_id:''}`,row.record_id?'PUT':'POST',p);}catch(e){if(e instanceof Fault && e.code==='write_outcome_uncertain')return verify(env,row,cf,request);await finish(env,row,'failed',{error:e instanceof Fault?e.code:'upstream_failed'},request);await env.DB.prepare('DELETE FROM dns_locks WHERE operation_id=?').bind(id).run();return operationStatus(env,user,id);}
  return verify(env,row,cf,request);
 }catch(e){await finish(env,row,'uncertain',{reason:e instanceof Fault?e.code:'execution_interrupted'},request);throw e;}
}
