import {expect,it} from 'vitest';
import {seasonalVisuals} from '../../app/shared/seasonal';
it('expires all seasonal branding and buffering after December even if the palette is manually retained',()=>{
 expect(seasonalVisuals(new Date(2026,11,31,23,59,59),'festival')).toBe(true);
 expect(seasonalVisuals(new Date(2027,0,1),'festival')).toBe(false);
 expect(seasonalVisuals(new Date(2026,10,1),'ember')).toBe(false);
 expect(seasonalVisuals(new Date(2026,9,29),'festival')).toBe(false);
});
