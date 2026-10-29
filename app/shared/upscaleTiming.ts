export const UPSCALE_FRAME_DEADLINE_MS=80;
/** Reject stale output, including frames invalidated by a seek. This does not measure source lip sync. */
export function freshUpscaleFrame(renderMs:number,mediaDriftMs:number):boolean {
  return Number.isFinite(renderMs)&&Number.isFinite(mediaDriftMs)&&renderMs>=0&&
    renderMs<=UPSCALE_FRAME_DEADLINE_MS&&Math.abs(mediaDriftMs)<=UPSCALE_FRAME_DEADLINE_MS;
}
