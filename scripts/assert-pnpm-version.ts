import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Publish guard: the running pnpm must match the .prototools pin, and the
// root package.json `packageManager` field (read by corepack and Vercel)
// must agree with it. .prototools is the single source of truth, so bumping
// pnpm only requires editing that file and `packageManager` together.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const protoToolsPath = resolve(scriptDir, '..', '.prototools');
const packageJsonPath = resolve(scriptDir, '..', 'package.json');
const hint = `Install or activate the pnpm version pinned in ${protoToolsPath} before publishing.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const pnpmVersionMatch = /^pnpm\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m.exec(
  readFileSync(protoToolsPath, 'utf8')
);

if (pnpmVersionMatch == null) {
  fail(
    [`Could not find a pinned pnpm version in ${protoToolsPath}.`, hint].join(
      '\n'
    )
  );
}

const pinnedVersion = pnpmVersionMatch[1];

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  packageManager?: string;
};
const packageManager = packageJson.packageManager ?? '(missing)';

if (packageManager !== `pnpm@${pinnedVersion}`) {
  fail(
    [
      `${packageJsonPath} declares packageManager ${packageManager}, but .prototools pins pnpm ${pinnedVersion}.`,
      `Set "packageManager": "pnpm@${pinnedVersion}" so both pins agree.`,
    ].join('\n')
  );
}

const pnpmVersion = spawnSync('pnpm', ['--version'], {
  encoding: 'utf8',
});

if (pnpmVersion.error != null) {
  fail(
    [`Could not run pnpm --version: ${pnpmVersion.error.message}.`, hint].join(
      '\n'
    )
  );
}

if (pnpmVersion.status !== 0) {
  fail(
    [
      `pnpm --version exited with status ${pnpmVersion.status ?? 'unknown'}.`,
      pnpmVersion.stderr.trim(),
      hint,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

const actualVersion = pnpmVersion.stdout.trim();

if (actualVersion !== pinnedVersion) {
  fail(
    [
      `Expected pnpm ${pinnedVersion}, but this command is running pnpm ${actualVersion || '(empty version output)'}.`,
      hint,
    ].join('\n')
  );
}
