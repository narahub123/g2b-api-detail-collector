import {EventEmitter} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
import {probeConnection,type ProbeEvent,type ProbeDependencies} from './connection-probe';

/** 외부 접속 없이 소켓의 연결·취소·정리를 관찰합니다. */
function setup(){
 const sockets:Array<EventEmitter&{destroy:ReturnType<typeof vi.fn>}>=[];
 const resolver={resolve4:vi.fn(async()=>['192.0.2.10']),resolve6:vi.fn(async()=>['2001:db8::10']),cancel:vi.fn()};
 const events:ProbeEvent[]=[];
 const socket=()=>{const value=Object.assign(new EventEmitter(),{destroy:vi.fn()});sockets.push(value);return value;};
 const deps:ProbeDependencies={resolver:()=>resolver,tcp:vi.fn(socket),tls:vi.fn(socket)};
 return {resolver,events,sockets,deps};
}
afterEach(()=>vi.useRealTimers());

it('DNS 무응답을 취소하고 다음 검사를 생략합니다',async()=>{
 vi.useFakeTimers();const t=setup();
 t.resolver.resolve4.mockImplementation(()=>new Promise(()=>{}));t.resolver.resolve6.mockImplementation(()=>new Promise(()=>{}));
 const work=probeConnection('run',new AbortController().signal,e=>t.events.push(e),t.deps);
 await vi.advanceTimersByTimeAsync(3000);await work;
 expect(t.resolver.cancel).toHaveBeenCalled();expect(t.sockets).toHaveLength(0);
 expect(t.events.filter(e=>e.phase==='dns').map(e=>e.outcome)).toEqual(['stage_timeout','stage_timeout']);
 expect(t.events.some(e=>e.phase==='tcp'&&e.outcome==='skipped')).toBe(true);
 expect(vi.getTimerCount()).toBe(0);
});
it('TCP 무응답을 정리하며 TLS를 시작하지 않습니다',async()=>{
 vi.useFakeTimers();const t=setup();t.resolver.resolve6.mockResolvedValue([]);
 const work=probeConnection('run',new AbortController().signal,e=>t.events.push(e),t.deps);
 await vi.advanceTimersByTimeAsync(3000);await work;
 expect(t.sockets[0].destroy).toHaveBeenCalled();expect(t.deps.tls).not.toHaveBeenCalled();
 expect(t.events.some(e=>e.phase==='tcp'&&e.outcome==='stage_timeout')).toBe(true);
 expect(vi.getTimerCount()).toBe(0);
});
it('동일 TCP 연결을 TLS에 전달하고 검사 IP를 별도 대상으로 기록합니다',async()=>{
 vi.useFakeTimers();const t=setup();t.resolver.resolve6.mockResolvedValue([]);
 const work=probeConnection('run',new AbortController().signal,e=>t.events.push(e),t.deps);
 await vi.advanceTimersByTimeAsync(0);t.sockets[0].emit('connect');
 await vi.advanceTimersByTimeAsync(0);t.sockets[1].emit('secureConnect');await work;
 expect(t.deps.tls).toHaveBeenCalledWith(t.sockets[0]);
 expect(t.events.find(e=>e.phase==='tcp'&&e.outcome==='completed')).toMatchObject({runId:'run',address:'192.0.2.10'});
 expect(t.events.every(e=>e.note.includes('실패 후 별도 검사'))).toBe(true);
 expect(t.sockets.every(s=>s.destroy.mock.calls.length>0)).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('TLS 정지 시 소켓을 파괴하고 제한 시간을 반환합니다',async()=>{
 vi.useFakeTimers();const t=setup();t.resolver.resolve6.mockResolvedValue([]);
 const work=probeConnection('run',new AbortController().signal,e=>t.events.push(e),t.deps);
 await vi.advanceTimersByTimeAsync(0);t.sockets[0].emit('connect');await vi.advanceTimersByTimeAsync(3000);await work;
 expect(t.events.some(e=>e.phase==='tls'&&e.outcome==='stage_timeout')).toBe(true);
 expect(t.sockets.every(s=>s.destroy.mock.calls.length>0)).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('전체 마감 시각 도달 시 진행 중 검사를 끝내고 후속 검사를 생략합니다',async()=>{
 vi.useFakeTimers();const t=setup();let clock=0;t.deps.now=()=>clock;
 const work=probeConnection('run',new AbortController().signal,e=>t.events.push(e),t.deps);
 await vi.advanceTimersByTimeAsync(0);clock=14999;t.sockets[0].emit('connect');
 await vi.advanceTimersByTimeAsync(0);clock=15000;await vi.advanceTimersByTimeAsync(1);await work;
 expect(t.events.some(e=>e.phase==='tls'&&e.outcome==='overall_timeout')).toBe(true);
 expect(t.events.some(e=>e.family===6&&e.phase==='tcp'&&e.outcome==='skipped')).toBe(true);
 expect(t.resolver.cancel).toHaveBeenCalled();expect(t.sockets.every(s=>s.destroy.mock.calls.length>0)).toBe(true);
 expect(vi.getTimerCount()).toBe(0);
});
it('배치 종료 신호가 DNS 대기를 중단합니다',async()=>{
 vi.useFakeTimers();const t=setup();t.resolver.resolve4.mockImplementation(()=>new Promise(()=>{}));
 const abort=new AbortController();const work=probeConnection('run',abort.signal,e=>t.events.push(e),t.deps);
 abort.abort();await work;
 expect(t.resolver.cancel).toHaveBeenCalled();expect(t.sockets).toHaveLength(0);
 expect(t.resolver.resolve4).not.toHaveBeenCalled();expect(t.resolver.resolve6).not.toHaveBeenCalled();
 expect(t.events.some(e=>e.outcome==='cancelled')).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it.each(['tcp','tls'])('배치 종료 신호가 %s 검사 소켓을 닫고 이후 주소 검사를 생략합니다',async(phase)=>{
 vi.useFakeTimers();const t=setup(),abort=new AbortController();
 const work=probeConnection('run',abort.signal,e=>t.events.push(e),t.deps);
 await vi.advanceTimersByTimeAsync(0);
 if(phase==='tls'){t.sockets[0].emit('connect');await vi.advanceTimersByTimeAsync(0);}
 abort.abort();await work;
 expect(t.events.some(e=>e.phase===phase&&e.outcome==='cancelled')).toBe(true);
 expect(t.events.some(e=>e.family===6&&e.phase==='tcp'&&e.outcome==='skipped')).toBe(true);
 expect(t.sockets.every(s=>s.destroy.mock.calls.length>0)).toBe(true);expect(vi.getTimerCount()).toBe(0);
 // 닫힌 소켓의 늦은 오류가 미처리 예외로 전파되지 않아야 합니다.
 for(const socket of t.sockets){socket.emit('error',new Error('늦은 오류'));socket.emit('close');expect(socket.listenerCount('error')).toBe(0);}
});
it('DNS 실패와 TLS 인증 실패는 별도 검사 결과로만 기록합니다',async()=>{
 vi.useFakeTimers();const t=setup();t.resolver.resolve6.mockRejectedValue(new Error('ENODATA'));
 const work=probeConnection('run',new AbortController().signal,e=>t.events.push(e),t.deps);
 await vi.advanceTimersByTimeAsync(0);t.sockets[0].emit('connect');await vi.advanceTimersByTimeAsync(0);
 t.sockets[1].emit('error',new Error('CERT_HAS_EXPIRED'));await work;
 expect(t.events.find(e=>e.phase==='dns'&&e.family===6)?.outcome).toBe('failed');
 expect(t.events.find(e=>e.phase==='tls')?.diagnostic?.message).toContain('CERT_HAS_EXPIRED');
 expect(t.sockets.every(s=>s.destroy.mock.calls.length>0)).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
