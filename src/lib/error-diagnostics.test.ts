import {expect,it} from 'vitest';
import {serializeError} from './error-diagnostics';

it('오류 원인과 복수 하위 오류 및 연결 속성을 JSON으로 보존합니다',()=>{
 const cause=Object.assign(new Error('connect'),{code:'ETIMEDOUT',address:'192.0.2.1',port:443,status:502});
 const error=new AggregateError([cause],'download',{cause});
 const result=JSON.parse(JSON.stringify(serializeError(error)));
 expect(result).toMatchObject({name:'AggregateError',message:'download',cause:{code:'ETIMEDOUT',address:'192.0.2.1',port:443,status:502},errors:[{message:'connect',code:'ETIMEDOUT'}]});
 expect(result.stack).toContain('AggregateError');
});
it('일반 객체와 원시값을 보존합니다',()=>{
 expect(serializeError({message:'failed',detail:{attempt:2},code:17})).toMatchObject({message:'failed',detail:{attempt:2},code:17});
 expect(serializeError('broken')).toMatchObject({message:'broken'});
 expect(serializeError(null)).toMatchObject({value:null});
});
it('getter와 toJSON을 실행하지 않으며 읽기 실패를 표시합니다',()=>{
 let calls=0; const input={message:'failed',get hidden(){calls++;throw Error('getter');},toJSON(){calls++;throw Error('json');}};
 const result=serializeError(input);
 expect(calls).toBe(0);expect(JSON.stringify(result)).toContain('accessor');
 const proxy=new Proxy({},{ownKeys(){throw Error('denied');}});
 expect(()=>serializeError(proxy)).not.toThrow();expect(JSON.stringify(serializeError(proxy))).toContain('unreadable');
});
it('비밀값과 URL 인증 및 본문과 연결 객체를 제거합니다',()=>{
 const input={message:'https://alice:pass@example.com/file?token=xyz#private postgres://u:p@db/name Bearer abc123',password:'hunter2',headers:{Authorization:'Bearer hidden',Cookie:'session=secret'},body:'payload',socket:{private:'socket-data'},client:{private:'client-data'},apiKey:'key-value'};
 const text=JSON.stringify(serializeError(input));
 expect(text).not.toMatch(/alice|xyz|private|u:p|abc123|hunter2|hidden|session=secret|payload|socket-data|client-data|key-value/);
 expect(text).toContain('https://example.com/file');
});
it('문자열 안의 JSON 인증 정보와 환경 비밀값을 제거합니다',()=>{
 const prior=process.env.G2B_SERVICE_KEY;process.env.G2B_SERVICE_KEY='test-real-service-key';
 try{expect(JSON.stringify(serializeError({message:'{"password":"hunter2","token":"abc"} test-real-service-key Authorization: Bearer credential'}))).not.toMatch(/hunter2|abc|test-real-service-key|credential/);}finally{if(prior===undefined)delete process.env.G2B_SERVICE_KEY;else process.env.G2B_SERVICE_KEY=prior;}
});
it('순환과 깊이 및 속성 배열 문자열 제한을 표시합니다',()=>{
 const input:Record<string,unknown>={message:'x'.repeat(9000),items:Array.from({length:60},(_,i)=>i)};input.self=input;
 let nested=input;for(let i=0;i<12;i++){const next={};nested.child=next;nested=next;}
 for(let i=0;i<60;i++)input['extra'+i]=i;
 const text=JSON.stringify(serializeError(input));
 expect(text).toContain('circular');expect(text).toContain('depth');expect(text).toContain('properties');expect(text).toContain('array');expect(text).toContain('string');
});
it('UTF-8 JSON 전체를 64KiB 이내로 제한하고 주요 원인을 우선합니다',()=>{
 const input:Record<string,unknown>={cause:{code:'ECONNRESET',message:'root'}};
 for(let i=0;i<45;i++)input['extra'+i]='한'.repeat(8000);
 const value=serializeError(input);expect(Buffer.byteLength(JSON.stringify(value),'utf8')).toBeLessThanOrEqual(65536);
 expect(value).toMatchObject({cause:{code:'ECONNRESET'}});expect(JSON.stringify(value)).toContain('budget');
});

it('스택 접근자를 실행하지 않고 해당 위치에 생략 이유를 표시합니다',()=>{
 let called=false;const error=new Error('failed');
 Object.defineProperty(error,'stack',{get(){called=true;throw Error('must not run');},configurable:true});
 expect(serializeError(error)).toMatchObject({message:'failed',stack:'[omitted: accessor]'});expect(called).toBe(false);
});
it('공유 원인은 반복 보존하고 프로토타입 키도 안전하게 저장합니다',()=>{
 const shared={code:'ECONNRESET'};const input=JSON.parse('{"__proto__":{"message":"own value"}}');input.cause=shared;input.errors=[shared];
 const result=serializeError(input);
 expect(result).toMatchObject({cause:{code:'ECONNRESET'},errors:[{code:'ECONNRESET'}]});
 expect(Object.hasOwn(result,'__proto__')).toBe(true);expect(Object.getPrototypeOf(result)).toBe(null);
});
it('취소된 Proxy도 읽기 실패로 기록합니다',()=>{
 const {proxy,revoke}=Proxy.revocable({},{});revoke();
 expect(serializeError(proxy)).toMatchObject({value:'[omitted: unreadable]'});
});
it('일반 Error를 사전 가공하지 않아도 원래 생성 위치의 스택을 보존합니다',()=>{
 const result=serializeError(new Error('failed'));
 expect(result.stack).toEqual(expect.stringContaining('Error: failed'));
 expect(result.stack).toEqual(expect.stringContaining('error-diagnostics.test.ts'));
});
it('네이티브 스택에서 이름 getter와 사용자 포매터를 실행하지 않습니다',()=>{
 let calls=0;const unsafe=new Error('failed');Object.defineProperty(unsafe,'name',{get(){calls++;return 'unsafe';}});
 const previous=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace');
 const formatter=()=>{calls++;return 'unsafe';};
 Object.defineProperty(Error,'prepareStackTrace',{value:formatter,configurable:true,writable:true});
 try{
  expect(serializeError(new Error('safe')).stack).toEqual(expect.stringContaining('Error: safe'));
  serializeError(unsafe);expect(calls).toBe(0);
  expect(Object.getOwnPropertyDescriptor(Error,'prepareStackTrace')?.value).toBe(formatter);
 }finally{if(previous)Object.defineProperty(Error,'prepareStackTrace',previous);else Reflect.deleteProperty(Error,'prepareStackTrace');}
});

it('기본 스택도 민감정보 제거와 문자열 제한을 적용합니다',()=>{
 const result=serializeError(new Error('https://alice:pass@example.com/file?token=hidden '+'x'.repeat(9000)));
 expect(typeof result.stack).toBe('string');
 expect(result.stack).not.toMatch(/alice|pass@|token=hidden/);
 expect((result.stack as string).length).toBeLessThanOrEqual(8000);
 expect(result.stack).toContain('[omitted: string]');
});
