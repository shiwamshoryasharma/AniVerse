import { expect, it } from 'vitest';
import { isPlayerCapturePermission } from '../../electron/cast/capturePermission';
it('allows only explicit display capture or Electron 44 capture requests without device types', () => {
  expect(isPlayerCapturePermission('display-capture', { isMainFrame: true })).toBe(true);
  expect(isPlayerCapturePermission('media', { isMainFrame: true, mediaTypes: [] })).toBe(true);
  for (const details of [{ isMainFrame:true,mediaTypes:['audio'] },{ isMainFrame:true,mediaTypes:['video'] },{ isMainFrame:true },{ isMainFrame:false,mediaTypes:[] }])
    expect(isPlayerCapturePermission('media',details)).toBe(false);
  expect(isPlayerCapturePermission('geolocation',{isMainFrame:true})).toBe(false);
});
