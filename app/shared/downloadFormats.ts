export const downloadableVideoPath = /\.(?:mp4|m3u8|ts|m2ts|mts|webm|mkv|mov|m4v|avi|mpg|mpeg|ogv|flv|wmv|3gp)$/i;

export function isDownloadableVideoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.search && !url.hash &&
      !url.username && !url.password && downloadableVideoPath.test(url.pathname);
  } catch { return false; }
}
