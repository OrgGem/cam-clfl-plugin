import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const directory=await mkdtemp(join(tmpdir(),'gem-stdio-'));
const client=new Client({name:'smoke',version:'1'});
try{await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/node/apps/local/src/cli.js'),'mcp'],env:{...process.env,GEM_DATA_DIR:directory}}));const result=await client.callTool({name:'whoami',arguments:{}});if(!JSON.stringify(result).includes('local-device'))throw Error('stdio smoke failed');const accounts=await client.callTool({name:'list_accounts',arguments:{}});if(accounts.isError)throw Error('listing failed');console.log('Compiled local stdio MCP handshake/tools passed.');}finally{await client.close();await rm(directory,{recursive:true,force:true});}
