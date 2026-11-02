import {Resolver} from 'node:dns/promises';
import type {EventEmitter} from 'node:events';
import {connect, type Socket} from 'node:net';
import {connect as connectTls} from 'node:tls';
import {diagnosticError,type DiagnosticError} from './diagnostics';

export const PROBE_NOTE='다운로드 실패 후 별도 검사이며 원래 요청의 연결 상태를 재현한 결과는 아님';
type Outcome='completed'|'failed'|'stage_timeout'|'overall_timeout'|'cancelled'|'skipped';
export type ProbeEvent={operation:'pdf-connection-diagnostic';runId:string;at:string;host:string;port:number;note:string;
 phase:'dns'|'tcp'|'tls';family:4|6;outcome:Outcome;elapsedMs:number;address?:string;addresses?:string[];diagnostic?:DiagnosticError};
type ProbeSocket=Pick<EventEmitter,'once'|'removeListener'>&{destroy:()=>unknown};
export type ProbeDependencies={resolver:()=>{resolve4:(host:string)=>Promise<string[]>;resolve6:(host:string)=>Promise<string[]>;cancel:()=>void};
 tcp:(address:string)=>ProbeSocket;tls:(socket:ProbeSocket)=>ProbeSocket;now?:()=>number};
const defaults:ProbeDependencies={resolver:()=>new Resolver(),tcp:address=>connect({host:address,port:443}),
 tls:socket=>connectTls({socket:socket as Socket,servername:'www.g2b.go.kr',rejectUnauthorized:true})};

/** 실패 후 별도 연결 검사를 실행하고 전체 제한과 취소 신호에 맞춰 자원을 정리합니다. */
export async function probeConnection(runId:string,signal:AbortSignal,report:(event:ProbeEvent)=>void,
 dependencies:ProbeDependencies=defaults):Promise<void>{
 const now=dependencies.now??(()=>performance.now()),deadline=now()+15000,resolver=dependencies.resolver();
 const sockets=new Set<ProbeSocket>(),pending=new Set<(outcome:Outcome)=>void>();
 let stopped:'overall_timeout'|'cancelled'|undefined;
 /** 전체 검사의 자원을 닫고 대기 중인 처리도 명시적으로 종료합니다. */
 const stop=(reason:'overall_timeout'|'cancelled')=>{
  if(stopped)return;stopped=reason;resolver.cancel();
  for(const finish of [...pending])finish(reason);
  for(const socket of sockets)socket.destroy();
 };
 /** 이벤트 루프가 지연돼도 기한이 지난 새 검사는 시작하지 않습니다. */
 const expired=()=>{if(!stopped&&now()>=deadline)stop('overall_timeout');return !!stopped;};
 /** 로그 출력 실패가 원래 추출 결과에 영향을 주지 않게 합니다. */
 const emit=(event:Omit<ProbeEvent,'operation'|'runId'|'at'|'host'|'port'|'note'>)=>{
  try{report({operation:'pdf-connection-diagnostic',runId,at:new Date().toISOString(),host:'www.g2b.go.kr',port:443,note:PROBE_NOTE,...event});}catch{/* 진단 출력 실패는 추출 결과를 변경하지 않습니다. */}
 };
 const abort=()=>stop('cancelled'),timer=setTimeout(()=>stop('overall_timeout'),15000);
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 /** 취소 직후 늦게 도착하는 소켓 오류도 수신하고 닫힌 뒤 보호 리스너를 제거합니다. */
 const track=(socket:ProbeSocket)=>{
  const ignore=()=>{};
  socket.once('error',ignore);socket.once('close',()=>socket.removeListener('error',ignore));sockets.add(socket);
  return socket;
 };
 /** DNS 완료와 취소를 함께 감시하고 늦게 도착하는 거부도 처리합니다. */
 const dns=(family:4|6)=>new Promise<string[]>(resolve=>{
  const started=now();let done=false;
  const finish=(outcome:Outcome,addresses:string[]=[],error?:unknown)=>{
   if(done)return;done=true;pending.delete(cancel);
   emit({phase:'dns',family,outcome,elapsedMs:Math.max(0,now()-started),addresses,...(error?{diagnostic:diagnosticError(error)}:{})});resolve(addresses);
  };
  const cancel=(outcome:Outcome)=>finish(outcome);pending.add(cancel);
  if(expired()){finish('skipped');return;}
  Promise.resolve().then(()=>expired()?[]:family===4?resolver.resolve4('www.g2b.go.kr'):resolver.resolve6('www.g2b.go.kr'))
   .then(addresses=>finish('completed',addresses),error=>finish('failed',[],error));
 });
 /** 연결·오류·취소 결과를 한 번만 확정하고 리스너와 타이머를 정리합니다. */
 const wait=(socket:ProbeSocket,event:'connect'|'secureConnect',phase:'tcp'|'tls',family:4|6,address:string)=>new Promise<boolean>(resolve=>{
  const started=now();let done=false;
  const remaining=deadline-now();
  const finish=(outcome:Outcome,error?:unknown)=>{
   if(done)return;done=true;clearTimeout(phaseTimer);pending.delete(cancel);
   socket.removeListener(event,success);socket.removeListener('error',failure);socket.removeListener('close',closed);
   emit({phase,family,address,outcome,elapsedMs:Math.max(0,now()-started),...(error?{diagnostic:diagnosticError(error)}:{})});resolve(outcome==='completed');
  };
  const cancel=(outcome:Outcome)=>finish(outcome),success=()=>{if(!expired())finish('completed');},failure=(error:Error)=>finish('failed',error);
  const closed=()=>finish('failed',new Error('검사 소켓이 연결 완료 전에 닫혔습니다.'));
  const phaseTimer=setTimeout(()=>{if(now()>=deadline)stop('overall_timeout');else{finish('stage_timeout');socket.destroy();}},Math.max(0,Math.min(3000,remaining)));
  pending.add(cancel);socket.once(event,success);socket.once('error',failure);socket.once('close',closed);
  if(expired())finish(stopped??'overall_timeout');
 });
 try{
  const dnsTimer=setTimeout(()=>{resolver.cancel();for(const finish of [...pending])finish(now()>=deadline?'overall_timeout':'stage_timeout');},Math.max(0,Math.min(3000,deadline-now())));
  let addresses:string[][];
  try{addresses=await Promise.all([dns(4),dns(6)]);}finally{clearTimeout(dnsTimer);}
  for(const [index,family] of ([4,6] as const).entries()){
   const address=addresses[index][0];
   const skip=(phase:'tcp'|'tls')=>emit({phase,family,address,outcome:'skipped',elapsedMs:0});
   if(!address||expired()){skip('tcp');skip('tls');continue;}
   let tcp:ProbeSocket|undefined,tls:ProbeSocket|undefined,phase:'tcp'|'tls'='tcp';
   try{
    tcp=track(dependencies.tcp(address));
    if(!await wait(tcp,'connect','tcp',family,address)||expired()){skip('tls');continue;}
    phase='tls';tls=track(dependencies.tls(tcp));
    await wait(tls,'secureConnect','tls',family,address);
   }catch(error){emit({phase,family,address,outcome:'failed',elapsedMs:0,diagnostic:diagnosticError(error)});if(phase==='tcp')skip('tls');}
   finally{tls?.destroy();tcp?.destroy();if(tls)sockets.delete(tls);if(tcp)sockets.delete(tcp);}
  }
 }finally{
  clearTimeout(timer);signal.removeEventListener('abort',abort);resolver.cancel();
  for(const socket of sockets)socket.destroy();
 }
}
