import {types} from 'node:util';

// 현재 Node.js 런타임이 제공한 접근자와 동일한 경우에만 스택을 읽습니다.
const nativeStackGetter=Object.getOwnPropertyDescriptor(new Error(),'stack')?.get;

/** 사용자 getter와 스택 포매터를 실행하지 않고 기본 오류 스택을 읽습니다. */
function nativeErrorStack(error:object,descriptors:PropertyDescriptorMap):string|undefined{
 if(!nativeStackGetter||descriptors.stack?.get!==nativeStackGetter||!types.isNativeError(error))return;
 for(const key of ['name','message']){
  const desc=descriptors[key];
  if(desc&&(!('value' in desc)||(desc.value!==undefined&&typeof desc.value!=='string')))return;
 }
 const previous=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace');
 if(previous&&!previous.configurable&&(!('value' in previous)||!previous.writable))return;
 // 기본 스택 생성 중 사용자 prepareStackTrace가 실행되지 않도록 동기 구간에서만 해제합니다.
 try{
  Object.defineProperty(Error,'prepareStackTrace',previous&&!previous.configurable?{value:undefined}:{value:undefined,writable:true,configurable:true});
  const stack:unknown=Reflect.apply(nativeStackGetter,error,[]);
  return typeof stack==='string'?stack:undefined;
 }catch{return undefined;}
 finally{
  if(previous)Object.defineProperty(Error,'prepareStackTrace',previous);
  else Reflect.deleteProperty(Error,'prepareStackTrace');
 }
}
/** JSON으로 보존하는 오류 정보. 추가 속성도 같은 안전한 값으로 유지합니다. */
export type DiagnosticValue = null | boolean | number | string | DiagnosticValue[] | {[key:string]:DiagnosticValue};
export type SerializedError = {[key:string]:DiagnosticValue};
const priority=['name','message','code','errno','syscall','address','port','status','statusCode','cause','errors','stack'];
const secretKey=/(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|database[_-]?url|service[_-]?key)/i;
const excluded=/^(?:body|requestBody|responseBody|request|response|req|res|socket|connection|client|agent|toJSON)$/i;

/** 인증값과 URL 자격 증명을 원문 문자열에서 제거합니다. */
function redact(text:string):string{
 for(const key of ['G2B_SERVICE_KEY','DATABASE_URL','PDF_WORKER_TOKEN']){const value=process.env[key];if(value)text=text.replaceAll(value,'[REDACTED]');}
 return text.replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi,'[REDACTED]')
 .replace(/https?:\/\/[^\s<>"']+/gi,value=>{try{const url=new URL(value);return `${url.protocol}//${url.host}${url.pathname}`;}catch{return '[URL REDACTED]';}})
 .replace(/\b(?:authorization|cookie|set-cookie)["']?\s*[:=][^\r\n]*/gi,'[REDACTED]')
 .replace(/\b(?:[a-z][a-z0-9_]*_)?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|service[_-]?key|database_url)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'[REDACTED]')
 .replace(/\bBearer\s+[^\s,;"']+/gi,'Bearer [REDACTED]');
}

/** 임의 getter와 toJSON을 호출하지 않고 원인 및 기본 오류 스택을 제한된 JSON으로 변환합니다. */
export function serializeError(error:unknown):SerializedError{
 // 생략 표시와 구조를 위한 여유를 두고 UTF-8 크기를 제한합니다.
 let remaining=60000;
 const ancestors=new Set<object>();
 /** 생략된 위치에 이유를 남깁니다. */
 const omitted=(reason:string):DiagnosticValue=>`[omitted: ${reason}]`;
 /** 정제된 문자열의 JSON 바이트 크기를 계산합니다. */
 function string(value:string):string{
  let safe=redact(value);
  if(safe.length>8000)safe=safe.slice(0,7960)+' [omitted: string]';
  const size=Buffer.byteLength(JSON.stringify(safe),'utf8');
  if(size>remaining)return '[omitted: budget]';remaining-=size;return safe;
 }
 /** 현재 조상만 추적해 공유 원인을 순환으로 오인하지 않습니다. */
 function visit(value:unknown,depth:number):DiagnosticValue{
  if(remaining<128)return omitted('budget');
  remaining-=16;
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string')return string(value);
  if(typeof value==='number')return Number.isFinite(value)?value:string(String(value));
  if(typeof value==='bigint'||typeof value==='undefined'||typeof value==='symbol')return string(String(value));
  if(typeof value==='function')return omitted('function');
  if(depth>8)return omitted('depth');
  const object=value as object;
  if(ancestors.has(object))return omitted('circular');
  ancestors.add(object);
  try{
   const array=Array.isArray(object);
   const descriptors=Object.getOwnPropertyDescriptors(object);
   const result:SerializedError=Object.create(null);
   // 기본 오류의 name/message도 접근자를 호출하지 않고 속성 설명자로 확인합니다.
   for(const key of ['name','message']){
    if(Object.hasOwn(descriptors,key))continue;
    let proto=Object.getPrototypeOf(object),steps=0;
    while(proto&&steps++<8){const desc=Object.getOwnPropertyDescriptor(proto,key);if(desc){descriptors[key]=desc;break;}proto=Object.getPrototypeOf(proto);}
   }
   const stack=nativeErrorStack(object,descriptors);
   if(stack!==undefined)descriptors.stack={value:stack};
   if(array){
    const length=descriptors.length?.value;
    const count=typeof length==='number'?Math.min(length,50):0;
    const values:DiagnosticValue[]=[];
    for(let i=0;i<count;i++){const desc=descriptors[String(i)];values.push(!desc?null:!('value' in desc)?omitted('accessor'):visit(desc.value,depth+1));}
    if(length>50)values.push(omitted('array'));
    return values;
   }
   const ownKeys=Object.keys(descriptors);
   const keys=[...priority.filter(key=>Object.hasOwn(descriptors,key)),...ownKeys.filter(key=>!priority.includes(key))];
   let count=0;
   for(const key of keys){
    if(count++>=50){result['$omittedProperties']=omitted('properties');break;}
    if(remaining<128){result['$omittedBudget']=omitted('budget');break;}
    const safeKey=string(key);const desc=descriptors[key];
    result[safeKey]=secretKey.test(key)?'[REDACTED]':excluded.test(key)?omitted('excluded'):!('value' in desc)?omitted('accessor'):visit(desc.value,depth+1);
   }
   if(Object.getOwnPropertySymbols(object).length)result['$omittedSymbols']=omitted('symbol properties');
   return result;
  }catch{return omitted('unreadable');}finally{ancestors.delete(object);}
 }
 const value=visit(error,0);
 const result:SerializedError=value!==null&&typeof value==='object'&&!Array.isArray(value)?value:{name:'ThrownValue',message:typeof value==='string'?value:'Non-Error value',value};
 // 다수의 생략 표시로 늘어난 크기도 최종 JSON에서 제한합니다.
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>65536){
  const trimmed:SerializedError=Object.create(null);
  for(const key of [...priority,...Object.keys(result).filter(key=>!priority.includes(key))]){
   if(!Object.hasOwn(result,key))continue;
   trimmed[key]=result[key];
   if(Buffer.byteLength(JSON.stringify(trimmed),'utf8')>65000){delete trimmed[key];trimmed['$omittedBudget']=omitted('budget');break;}
  }
  return trimmed;
 }
 return result;
}




