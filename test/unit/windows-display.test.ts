import { expect, it } from 'vitest';
import { WindowsDisplay } from '../../electron/cast/windowsDisplay';
it('opens the Windows wireless display chooser through a fixed system URI', async () => {
  const opened:string[]=[];
  const display=new WindowsDisplay('win32',async uri=>{opened.push(uri);});
  expect(await display.open('connect')).toEqual({opened:'connect',fallback:false});
  expect(opened).toEqual(['ms-settings-connectabledevices:devicediscovery']);
});
it('falls back to display settings if the native chooser cannot be launched', async () => {
  const opened:string[]=[];
  const display=new WindowsDisplay('win32',async uri=>{opened.push(uri);if(opened.length===1)throw new Error('No URI handler');});
  expect(await display.open('connect')).toEqual({opened:'display',fallback:true});
  expect(opened).toEqual(['ms-settings-connectabledevices:devicediscovery','ms-settings:display']);
});
it('rejects unsupported platforms and arbitrary settings targets', async () => {
  let opens=0;
  await expect(new WindowsDisplay('linux',async()=>{opens++;}).open('connect')).rejects.toThrow(/Windows/);
  await expect(new WindowsDisplay('win32',async()=>{opens++;}).open('bad' as 'connect')).rejects.toThrow(/target/);
  expect(opens).toBe(0);
});
