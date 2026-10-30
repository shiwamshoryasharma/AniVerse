import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {RustPolicy} from '../../app/core/security/rustPolicy';
it('refuses an altered or malformed embedded policy rather than installing a permissive fallback',()=>{
 const bytes=readFileSync('dist/electron/security.wasm');
 expect(()=>new RustPolicy(bytes,'0'.repeat(64))).toThrow(/integrity/);
 expect(()=>new RustPolicy(new Uint8Array([0]))).toThrow();
});
it('rejects oversized requests without breaking subsequent legitimate source decisions',()=>{
 const policy=new RustPolicy(readFileSync('dist/electron/security.wasm'));
 expect(policy.decide({context:'network',url:'https://example.org/'+'x'.repeat(20000)}).allowed).toBe(false);
 expect(policy.snapshot().ready).toBe(true);
 expect(policy.decide({context:'network',url:'https://example.org/video.mp4'}).allowed).toBe(true);
});
