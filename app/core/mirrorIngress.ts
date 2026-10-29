/** Ordered, bounded ingress from the trusted renderer's MediaRecorder. */
export class MirrorIngress {
  private expected = 0;
  private pendingBytes = 0;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private write: (bytes: Uint8Array) => Promise<void>) {}
  async push(sequence: number, bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Capture input is closed.');
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 2_000_000) throw new Error('Invalid capture chunk size.');
    if (sequence !== this.expected) throw new Error('Invalid capture chunk sequence.');
    if (this.pendingBytes + bytes.length > 8_000_000) throw new Error('The encoder cannot keep up with this capture.');
    this.expected++; this.pendingBytes += bytes.length;
    const operation = this.tail.then(() => {
      if (this.closed) throw new Error('Capture input is closed.');
      return this.write(bytes);
    });
    this.tail = operation.catch(() => { this.closed = true; });
    try { await operation; } finally { this.pendingBytes -= bytes.length; }
  }
  close() { this.closed = true; }
}
