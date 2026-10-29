import { expect, it } from 'vitest';
import { CastDiscoveryRecords } from '../../electron/cast/discoveryRecords';
const service='Fixture._googlecast._tcp.local';
const srv={name:service,type:'SRV',data:{target:'fixture.local',port:8009},ttl:120};
const txt={name:service,type:'TXT',data:[Buffer.from('id=fixture'),Buffer.from('fn=Living room'),Buffer.from('md=Google TV')],ttl:120};
it('assembles Google Cast devices from SRV, TXT and address records arriving in different packets',()=>{
  const records=new CastDiscoveryRecords();
  records.add([srv]);records.add([txt]);
  expect(records.devices()).toEqual([]);
  records.add([{name:'FIXTURE.local.',type:'A',data:'192.168.1.20',ttl:120}]);
  expect(records.devices()).toEqual([{id:'fixture',name:'Living room',model:'Google TV',host:'192.168.1.20',port:8009}]);
});
it('never substitutes an unrelated address or advertises non-Google Cast displays',()=>{
  const records=new CastDiscoveryRecords();
  records.add([srv,{name:'another.local',type:'A',data:'192.168.1.30'}, {name:'TV._miracast._tcp.local',type:'SRV',data:{target:'another.local',port:8009}}]);
  expect(records.devices()).toEqual([]);
});
it('removes a goodbye service and ignores malformed multicast records',()=>{
  const records=new CastDiscoveryRecords();
  records.add([srv,txt,{name:'fixture.local',type:'A',data:'192.168.1.20'}]);
  expect(records.devices()).toHaveLength(1);
  records.add([{...srv,ttl:0},{name:null,type:'SRV'}, {...srv,data:{port:-1,target:42}}]);
  expect(records.devices()).toEqual([]);
});
