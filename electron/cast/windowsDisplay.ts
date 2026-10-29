export const WINDOWS_DISPLAY_TARGETS = {
  connect: 'ms-settings-connectabledevices:devicediscovery', display: 'ms-settings:display', sound: 'ms-settings:sound',
} as const;
export class WindowsDisplay {
  constructor(private platform: string, private launch: (uri: string) => Promise<void>) {}
  async open(target: keyof typeof WINDOWS_DISPLAY_TARGETS): Promise<{ opened: keyof typeof WINDOWS_DISPLAY_TARGETS; fallback: boolean }> {
    if (this.platform !== 'win32') throw new Error('Wireless display connections require Windows.');
    if (!Object.hasOwn(WINDOWS_DISPLAY_TARGETS, target)) throw new Error('Invalid wireless display target.');
    try { await this.launch(WINDOWS_DISPLAY_TARGETS[target]); return { opened: target, fallback: false }; }
    catch (error) {
      if (target !== 'connect') throw error;
      await this.launch(WINDOWS_DISPLAY_TARGETS.display);
      return { opened: 'display', fallback: true };
    }
  }
}
