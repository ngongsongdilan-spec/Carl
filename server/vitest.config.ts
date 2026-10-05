import { defineConfig } from 'vitest/config';

/**
 * `node:sqlite` is a builtin, but Vite strips the `node:` prefix and then tries
 * to load `sqlite` from node_modules, which does not exist. This plugin hands
 * node-prefixed specifiers straight back to Node's own resolver.
 *
 * Typed loosely because Vitest bundles its own copy of Vite, so the root `vite`
 * types are structurally different even though the runtime shape matches.
 */
function nodeBuiltins() {
  return {
    name: 'node-builtins',
    enforce: 'pre' as const,
    resolveId(source: string) {
      if (source.startsWith('node:')) return { id: source, external: true };
      return null;
    },
  };
}

export default defineConfig({
  plugins: [nodeBuiltins()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    reporters: ['default'],
  },
});
