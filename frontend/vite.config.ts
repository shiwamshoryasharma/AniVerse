import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/** Injects a Content-Security-Policy; the dev variant allows Vite's HMR client. */
function csp(dev: boolean): Plugin {
  const policy = [
    "default-src 'self'",
    `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: media:",
    "font-src 'self' data:",
    "media-src 'self' blob: media: https: http:",
    `connect-src 'self' https: http: media: blob:${dev ? ' ws:' : ''}`,
    "worker-src 'self' blob:",
    'frame-src https: http:',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'aniverse-csp',
    transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ command }) => ({
  root,
  base: './',
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), csp(command === 'serve')],
  build: {
    outDir: fileURLToPath(new URL('../dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5273, strictPort: true, host: '127.0.0.1' },
}));
