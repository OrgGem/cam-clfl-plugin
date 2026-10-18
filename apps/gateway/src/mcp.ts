import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {z} from 'zod';
import {AppEnv,Fault,targetSchema,zoneSchema} from '../../../packages/core/src/security';
import {readInventory,readNames,readSchema,listConnections,listAccounts} from '../../../packages/core/src/inventory';
import {bearerUser} from '../../control/src/auth';
export async function mcp(request:Request,env:AppEnv,requestId:string) {
 const user=await bearerUser(env,request.headers.get('Authorization')??undefined);
 if(request.headers.has('Origin') && request.headers.get('Origin')!==env.APP_ORIGIN)throw new Fault(403,'invalid_origin');
 const server=new McpServer({name:'Gem Cloudflare Manager',version:'0.1.0'});
 const wrap=(fn:()=>Promise<unknown>)=>async()=>{try{return {content:[{type:'text' as const,text:JSON.stringify(await fn())}]};}catch(e){return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:e instanceof Fault?e.code:e instanceof z.ZodError?'invalid_input':'internal_error',request_id:requestId})}]};}};
 server.registerTool('whoami',{description:'Current authenticated app identity. Never pass a user_id.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true}},wrap(async()=>({user:await env.DB.prepare('SELECT id,email FROM users WHERE id=?').bind(user).first(),request_id:requestId})));
 server.registerTool('list_connections',{description:'List explicitly owned or shared connections.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true}},wrap(()=>listConnections(env,user)));
 server.registerTool('list_accounts',{description:'Resolve explicit connection/account target and alias before resource calls. Never guess.',inputSchema:z.object({}).strict(),annotations:{readOnlyHint:true}},wrap(()=>listAccounts(env,user)));
 for(const name of readNames)server.registerTool(name,{description:'Read one explicit target. Results carry connection/account/alias/request ID. Page size 50; retry 429 later.',inputSchema:name==='list_dns_records'?zoneSchema:readSchema,annotations:{readOnlyHint:true}},args=>wrap(()=>readInventory(env,user,name,args,requestId))());
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(transport);return transport.handleRequest(request);
}
