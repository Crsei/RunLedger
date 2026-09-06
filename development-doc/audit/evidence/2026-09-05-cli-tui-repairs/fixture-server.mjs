import http from 'node:http';
import fs from 'node:fs';
import { decodeRequest, encodeStream } from '/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger/dist/auth-gateway/codecs/responses.js';
const dir='/tmp/runledger-command-repair-20260905';
let count=0;
const server=http.createServer(async(req,res)=>{
 try {
  if(req.method!=='POST'){res.writeHead(200);res.end('audit fixture');return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const request=decodeRequest(JSON.parse(raw));
  const messages=request.context.messages;
  const last=messages.at(-1);
  const user=messages.filter(m=>m.role==='user').at(-1);
  const question=typeof user?.content==='string'?user.content:user?.content?.map(c=>c.text??'').join('')??'';
  const toolNames=request.context.tools?.map(t=>t.name)??[];
  fs.appendFileSync(dir+'/fixture-requests.jsonl',JSON.stringify({sequence:++count,path:req.url,roles:messages.map(m=>m.role),question,toolNames,lastTool:last?.role==='toolResult'?{name:last.toolName,error:last.isError,content:last.content}:undefined})+'\n');
  if(question.includes('触发错误')&&toolNames.length){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'AUDIT_PROVIDER_UNAVAILABLE',type:'server_error'}}));return;}
  let text='4';let tool;
  if(!toolNames.length)text='运行测试';
  else if(last?.role==='toolResult')text='工具结果：'+last.content.map(c=>c.text??'').join('').slice(0,700);
  else if(question.includes('读取'))tool={type:'toolCall',id:'audit_read_'+count,name:'read',arguments:{path:'package.json',offset:1,limit:6}};
  else if(question.includes('执行命令'))tool={type:'toolCall',id:'audit_bash_'+count,name:'bash',arguments:{command:'printf audit-ok'}};
  else if(question.includes('上一轮')){
   const previous=messages.filter(m=>m.role==='assistant').at(-1);
   text='上一轮回答：'+(previous?.content?.filter(c=>c.type==='text').map(c=>c.text).join('')??'无');
  }
  const message={role:'assistant',content:[tool??{type:'text',text}],api:'azure-openai-responses',provider:'audit-fixture',model:request.model,usage:{input:20,output:8,cacheRead:0,cacheWrite:0,totalTokens:28,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:tool?'toolUse':'stop',timestamp:Date.now()};
  async function* events(){
   yield {type:'start',partial:message};
   if(tool){yield {type:'toolcall_start',contentIndex:0,partial:message};yield {type:'toolcall_delta',contentIndex:0,delta:JSON.stringify(tool.arguments),partial:message};yield {type:'toolcall_end',contentIndex:0,toolCall:tool,partial:message};}
   else {yield {type:'text_start',contentIndex:0,partial:message};yield {type:'text_delta',contentIndex:0,delta:text,partial:message};yield {type:'text_end',contentIndex:0,content:text,partial:message};}
   yield {type:'done',reason:message.stopReason,message};
  }
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  for await(const chunk of encodeStream(events()))res.write(chunk);
  res.end();
 }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:e.message}}));}
});
server.listen(0,'127.0.0.1',()=>{const port=server.address().port;fs.writeFileSync(dir+'/fixture-port.txt',String(port));console.log('Audit Responses fixture listening on loopback port '+port);});
