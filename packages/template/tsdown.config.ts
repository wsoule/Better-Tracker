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
    platform: 'neutral',
  },
]);

export default config;
