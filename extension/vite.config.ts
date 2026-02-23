
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
    plugins: [react()],
    define: {
        __MUGEN_DEBUG__: false, // Dead-code-eliminates all debug paths in production
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        minify: 'esbuild',
        rollupOptions: {
            input: {
                popup: resolve(__dirname, 'src/ui/popup/index.html'),
                options: resolve(__dirname, 'src/ui/options/index.html'),
                background: resolve(__dirname, 'src/background/index.ts'),
                content: resolve(__dirname, 'src/content/index.ts'),
                'main-world': resolve(__dirname, 'src/content/main-world.ts'),
            },
            output: {
                entryFileNames: (chunkInfo) => {
                    if (chunkInfo.name === 'background') return 'background.js';
                    if (chunkInfo.name === 'content') return 'content.js';
                    if (chunkInfo.name === 'main-world') return 'main-world.js';
                    return 'assets/[name]-[hash].js';
                },
                chunkFileNames: 'assets/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash].[ext]',
            },
        },
    },
    resolve: {
        alias: {
            '@mugenblock/shared': resolve(__dirname, '../shared/src'),
        },
    },
});
