import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // 将 /api 请求代理到后端 NestJS 服务
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3520',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: ['agora-rtc-sdk-ng'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 减少 chunk 数量，避免页面加载时 16 个并发请求打满 OpenResty 连接池
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
    commonjsOptions: {
      include: [/agora-rtc-sdk-ng/, /node_modules/],
    },
  },
});
