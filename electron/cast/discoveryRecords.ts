import { isIP } from 'node:net';
import type { CastDevice } from '../../app/shared/types';
type RecordValue = { name?: unknown; type?: unknown; data?: unknown; ttl?: unknown };
const normal = (value: string) => value.toLowerCase().replace(/\.$/, '');
const serviceName = (name: string) => name.endsWith('._googlecast._tcp.local');
export class CastDiscoveryRecords {
  private records = new Map<string, RecordValue & { name: string; type: string }>();
  add(values: unknown[]) {
    for (const value of values.slice(0, 256)) {
      if (!value || typeof value !== 'object') continue;
      const record = value as RecordValue;
      if (typeof record.name !== 'string' || record.name.length > 255 || typeof record.type !== 'string') continue;
      const name = normal(record.name), key = record.type + ':' + name;
      if (record.ttl === 0) { this.records.delete(key); continue; }
      if (['A','SRV','TXT','PTR'].includes(record.type) && (this.records.has(key) || this.records.size < 1024))
        this.records.set(key, { ...record, name, type: record.type });
    }
  }
  questions(): { name: string; type: 'SRV' | 'TXT' | 'A' }[] {
    const result: {name:string;type:'SRV'|'TXT'|'A'}[] = [];
    for (const r of this.records.values()) {
      if (r.type === 'PTR' && r.name === '_googlecast._tcp.local' && typeof r.data === 'string' && serviceName(normal(r.data))) {
        for (const type of ['SRV','TXT'] as const) if (!this.records.has(type+':'+normal(r.data))) result.push({name:r.data,type});
      }
      if (r.type === 'SRV' && serviceName(r.name)) {
        const target=(r.data as {target?:unknown})?.target;
        if (typeof target === 'string' && !this.records.has('A:'+normal(target))) result.push({name:target,type:'A'});
      }
    }
    return result.slice(0,64);
  }
  devices(): CastDevice[] {
    const found = new Map<string,CastDevice>();
    for (const r of this.records.values()) {
      if (r.type !== 'SRV' || !serviceName(r.name) || !r.data || typeof r.data !== 'object') continue;
      const { target, port } = r.data as {target?:unknown;port?:unknown};
      if (typeof target !== 'string' || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      const host=this.records.get('A:'+normal(target))?.data;
      if (typeof host !== 'string' || isIP(host) !== 4 || host.startsWith('127.') || host === '0.0.0.0') continue;
      const fields:Record<string,string>={}, txt=this.records.get('TXT:'+r.name)?.data;
      if (Array.isArray(txt)) for (const entry of txt.slice(0,32)) {
        if (!(entry instanceof Uint8Array)) continue;
        const value=Buffer.from(entry).toString('utf8'), at=value.indexOf('=');
        if (at>0) fields[value.slice(0,at)]=value.slice(at+1).split('').filter(character=>character.charCodeAt(0)>=32).join('').slice(0,200);
      }
      const id=fields.id||r.name;
      found.set(id,{id,name:fields.fn||r.name.split('._googlecast')[0],model:fields.md||'Chromecast',host,port});
    }
    return [...found.values()].sort((a,b)=>a.name.localeCompare(b.name));
  }
}
