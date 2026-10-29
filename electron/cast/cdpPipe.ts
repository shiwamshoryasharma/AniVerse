import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

/** CDP uses NUL-delimited JSON on inherited pipes. No listening debugging port. */
export class CdpPipe extends EventEmitter {
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private input: Writable, private output: Readable) {
    super();
    output.on('data', this.read);
    output.once('end', this.ended);
    output.once('error', this.ended);
    input.once('error', this.ended);
  }
  call<T = any>(method: string, params: object = {}, sessionId?: string, timeout = 40000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Chrome casting connection is closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Chrome did not answer '+method+'.')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(JSON.stringify({ id, method, params, sessionId })+'\0', error => { if (error) this.close(); });
    });
  }
  private read = (chunk: Buffer) => {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8_000_000) { this.close(); return; }
    let at: number;
    while ((at = this.buffer.indexOf(0)) >= 0) {
      const frame = this.buffer.subarray(0, at); this.buffer = this.buffer.subarray(at+1);
      let message: any;
      try { message = JSON.parse(frame.toString('utf8')); } catch { this.close(); return; }
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer); this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(String(message.error.message ?? 'Chrome casting failed.')));
        else waiter.resolve(message.result ?? {});
      } else if (typeof message.method === 'string') this.emit(message.method, message.params ?? {}, message.sessionId);
    }
  };
  private ended = () => this.close();
  close() {
    if (this.closed) return; this.closed = true;
    this.output.removeListener('data', this.read); this.output.removeListener('end', this.ended); this.output.removeListener('error', this.ended);
    // Retain an input error listener until the child exits: a pipe may close during write.
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Chrome casting connection is closed.')); }
    this.pending.clear(); this.buffer = Buffer.alloc(0); this.emit('closed');
  }
}
