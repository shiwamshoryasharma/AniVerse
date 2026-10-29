import { expect, it } from 'vitest';
import { freshUpscaleFrame } from '../../app/shared/upscaleTiming';
it('presents only completed frames within the render and media-clock deadline',()=>{
  expect(freshUpscaleFrame(16,30)).toBe(true);
  expect(freshUpscaleFrame(100,0)).toBe(false);
  expect(freshUpscaleFrame(5,100)).toBe(false);
  expect(freshUpscaleFrame(5,-100)).toBe(false);
});
it('rejects invalid timing instead of presenting an unmeasured delayed frame',()=>{
  expect(freshUpscaleFrame(Number.NaN,0)).toBe(false);
  expect(freshUpscaleFrame(0,Number.POSITIVE_INFINITY)).toBe(false);
  expect(freshUpscaleFrame(-1,0)).toBe(false);
});
