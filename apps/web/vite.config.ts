import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // React rarely changes between releases, so it gets its own long-lived chunk.
      output: { manualChunks: id => /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'react' : undefined },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/terminal': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
});
