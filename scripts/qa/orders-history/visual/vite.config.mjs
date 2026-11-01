import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../../..')

// Builds the REAL OrderHistory / ConfirmOrderButton components with the app's real Tailwind theme and Spanish messages. Only the framework seams are
// replaced: next-intl (reads messages/es.json), the Supabase browser client (inert stub) and `fetch` (scenarios in main.tsx). Synthetic data only.
export default defineConfig({
  root: here,
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [
      { find: 'next-intl', replacement: path.join(here, 'shims/next-intl.ts') },
      { find: '@/lib/supabase/client', replacement: path.join(here, 'shims/supabase-client.ts') },
      { find: '@', replacement: path.join(repo, 'src') },
    ],
  },
  css: { postcss: { plugins: [(await import('@tailwindcss/postcss')).default()] } },
  build: { outDir: process.env.QA_OUT ?? path.join(here, 'dist'), emptyOutDir: true },
})
