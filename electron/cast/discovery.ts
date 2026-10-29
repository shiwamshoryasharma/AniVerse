import os from 'node:os';
import makeMdns from 'multicast-dns';
import { CastDiscoveryRecords } from './discoveryRecords';
import type { CastDevice } from '../../app/shared/types';
/** Google Cast is mDNS; Windows wireless displays use a separate Miracast chooser. */
export function discoverCastDevices(timeoutMs = 5000): Promise<CastDevice[]> {
  return new Promise((resolve, reject) => {
    const addresses = [...new Set(Object.values(os.networkInterfaces()).flatMap(list => (list ?? [])
      .filter(ni => ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')).map(ni => ni.address)))].slice(0,16);
    if (!addresses.length) { reject(new Error('No local IPv4 network is available for Google Cast discovery.')); return; }
    const records = new CastDiscoveryRecords(), sockets: ReturnType<typeof makeMdns>[] = [], failed = new Set<ReturnType<typeof makeMdns>>();
    for (const address of addresses) {
      const mdns=makeMdns({interface:address,bind:'0.0.0.0'}); sockets.push(mdns);
      mdns.on('error',()=>failed.add(mdns));
      mdns.on('response',response=>records.add([...response.answers,...response.additionals]));
      const ask=()=>{if(!failed.has(mdns))mdns.query({questions:[{name:'_googlecast._tcp.local',type:'PTR'},...records.questions()]});};
      mdns.on('ready',ask);
    }
    const timer=setInterval(()=>{for(const mdns of sockets)if(!failed.has(mdns))mdns.query({questions:[{name:'_googlecast._tcp.local',type:'PTR'},...records.questions()]});},1000);
    setTimeout(()=>{
      clearInterval(timer);
      for(const mdns of sockets) { try { mdns.destroy(); } catch { failed.add(mdns); } }
      if(failed.size===sockets.length)reject(new Error('Google Cast discovery could not use the network. Check firewall or VPN settings. Windows wireless displays use the Windows chooser.'));
      else resolve(records.devices());
    },timeoutMs);
  });
}
