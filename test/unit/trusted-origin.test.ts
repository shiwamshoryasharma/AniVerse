import {expect,it} from 'vitest';
import {trustedAppUrl} from '../../app/shared/trustedOrigin';
it('never equates unrelated opaque origins with the app custom scheme',()=>{
 for(const candidate of ['file:///C:/private/index.html','data:text/html,unsafe','app://attacker/index.html','about:blank','app://user:pass@aniverse/index.html']){
  expect(trustedAppUrl(candidate,'app://aniverse/index.html'),candidate).toBe(false);
 }
 expect(trustedAppUrl('app://aniverse/index.html#/watch/1','app://aniverse/index.html')).toBe(true);
 expect(trustedAppUrl('http://localhost:5174','http://localhost:5173')).toBe(false);
});
