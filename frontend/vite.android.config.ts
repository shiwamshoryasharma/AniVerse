import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { csp } from './vite.config.ts';
export default defineConfig({
  root:fileURLToPath(new URL('.',import.meta.url)),base:'./',plugins:[react(),csp(false)],
  cacheDir:fileURLToPath(new URL('../test/cache/android-0.1.0/vite',import.meta.url)),
  build:{outDir:fileURLToPath(new URL('../dist/android',import.meta.url)),emptyOutDir:true,target:'chrome124',sourcemap:false,rollupOptions:{input:fileURLToPath(new URL('./android.html',import.meta.url))}},
});
