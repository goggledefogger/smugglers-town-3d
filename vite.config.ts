import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // the site is public while the repo is private: a source map would
    // publish the whole TypeScript source at the hosting URL
    sourcemap: false
  },
  server: {
    port: 5173
  }
});
