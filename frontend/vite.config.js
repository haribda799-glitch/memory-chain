import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  base: process.env.NODE_ENV === 'production' ? '/memory-chain/' : '/',
  build: { outDir: 'dist' },
  define: { global: 'globalThis' },
});
