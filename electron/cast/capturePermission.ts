/** Electron 44 reports display capture as media with no camera/microphone types. */
export function isPlayerCapturePermission(permission: string, details: { isMainFrame?: boolean; mediaTypes?: string[] }): boolean {
  return details.isMainFrame === true && (permission === 'display-capture' ||
    (permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0));
}
