import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig[] = defineConfig([
  {
    entry: ['src/index.ts'],
    tsconfig: './tsconfig.json',
    clean: true,
    dts: {
      sourcemap: true,
      // Without this, isolatedDeclarations makes the dts plugin pick its
      // oxc generator; keep emitting declarations with TypeScript 7.
      generator: 'tsgo',
    },
    platform: 'node',
    // Node platform defaults to .mjs/.d.mts; package.json exports point at
    // .js/.d.ts ("type": "module" makes .js ESM), so keep plain extensions.
    fixedExtension: false,
  },
]);

export default config;
