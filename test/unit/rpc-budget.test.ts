import {expect,it} from 'vitest';
import {boundedInput,RpcBudget} from '../../app/core/security/rpcBudget';
it('admits normal binary chunks but rejects oversized, cyclic or excessive input structure',()=>{
 expect(boundedInput({chunk:new Uint8Array(2*1024*1024)})).toBe(true);
 expect(boundedInput({text:'x'.repeat(9*1024*1024)})).toBe(false);
 const cyclic:{self?:unknown}={};cyclic.self=cyclic;
 expect(boundedInput(cyclic)).toBe(false);
 expect(boundedInput(Array.from({length:3000},()=>1))).toBe(false);
});
it('bounds in-flight and burst work and releases capacity and destroyed senders',()=>{
 const budget=new RpcBudget();
 for(let i=0;i<128;i++)expect(budget.begin(1,0)).toBe(true);
 expect(budget.begin(1,0)).toBe(false);
 for(let i=0;i<128;i++)budget.end(1);
 expect(budget.begin(1,0)).toBe(true);budget.end(1);
 budget.forget(1);
 for(let i=0;i<600;i++){expect(budget.begin(1,0)).toBe(true);budget.end(1);}
 expect(budget.begin(1,0)).toBe(false);
 expect(budget.begin(1,10001)).toBe(true);
});
