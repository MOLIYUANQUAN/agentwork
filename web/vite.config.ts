import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时：npm run dev（5173），接口和 WebSocket 转给 8787 上的 server
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
