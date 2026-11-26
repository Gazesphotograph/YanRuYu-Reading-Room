import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// The renderer bundle is emitted next to the native modules it still hosts:
// resources/app/dist/app/main.js loads ../room-entry.js at runtime. Electron and
// the Playwright suites open resources/app/dist/index.html directly, so the
// output must live in-tree (it is git-ignored and rebuilt by every build/test).
export default defineConfig({
  root: fromRoot('./src/renderer'),
  base: './',
  publicDir: false,
  plugins: [vue()],
  resolve: { alias: { '@': fromRoot('./src/renderer') } },
  build: {
    outDir: fromRoot('./resources/app/dist/app'),
    emptyOutDir: true,
    target: 'esnext',
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: fromRoot('./src/renderer/main.ts'),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: assetInfo => {
          const isCss =
            assetInfo.names?.some(name => name.endsWith('.css')) ||
            (assetInfo.name?.endsWith('.css') ?? false);
          return isCss ? 'main.css' : 'assets/[name]-[hash][extname]';
        },
      },
    },
    cssCodeSplit: false,
  },
});
