import { readFile, writeFile, appendFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

// The one isolated HTTPS fixture behind the tests' stub `curl`. It serves only the
// exact URLs install.sh and launcher.js build for the runner's own platform
// (install.sh:6-16,42-43,53; launcher.js:9,90): current.json and launcher.js from
// main, the Bun zip for this platform's package, and the release CLI asset for
// this platform. With VIRGO_TEST_GITHUB set it also serves the GitHub Release API
// under each endpoint's exact Accept header (github-release.ts:182,189); a `.first`
// variant is served once. Any other URL exits 94.
export const platform = process.platform === 'darwin' && process.arch === 'arm64' ? { os: 'macos', architecture: 'arm64' }
  : process.platform === 'linux' && process.arch === 'x64' ? { os: 'linux', architecture: 'x64' } : null;
export const bunPackage = platform?.os === 'linux' ? 'bun-linux-x64' : 'bun-darwin-aarch64';
export const cliAsset = platform && `virgo-${platform.os}-${platform.architecture}`;
const REPOSITORY = 'virgo-codes/virgo-release', BUN_VERSION = '1.3.14';

if (import.meta.main) {
  const args = process.argv.slice(2), url = args.at(-3), out = args.at(-1), env = process.env;
  await appendFile(env.VIRGO_TEST_DOWNLOAD_LOG, JSON.stringify(args) + '\n');
  if (args.at(-2) !== '--output' || !url.startsWith('https://')) process.exit(93);
  if (env.VIRGO_TEST_FAIL && url.includes(env.VIRGO_TEST_FAIL)) process.exit(23);
  if (env.VIRGO_TEST_INTERRUPT && url.includes(env.VIRGO_TEST_INTERRUPT)) { process.kill(process.ppid, 'SIGTERM'); process.exit(143); }
  const exists = path => lstat(path).then(() => true, () => false);
  const header = name => { const values = []; for (let i = 0; i < args.length; i++) if (args[i] === '--header' && args[i + 1]?.toLowerCase().startsWith(name + ':')) values.push(args[i + 1].slice(name.length + 1).trim()); return values; };
  const api = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/releases\/(tags|assets)\/([A-Za-z0-9._-]+)$/u.exec(url);
  let source = null;
  if (api && env.VIRGO_TEST_GITHUB) {
    const accept = api[3] === 'tags' ? 'application/vnd.github+json' : 'application/octet-stream';
    if (JSON.stringify(header('accept')) !== JSON.stringify([accept])) process.exit(95);
    const path = join(env.VIRGO_TEST_GITHUB, api[1], api[2], api[3], api[3] === 'tags' ? api[4] + '.json' : api[4]);
    if (await exists(path + '.first')) { await writeFile(out, await readFile(path + '.first')); await rm(path + '.first'); process.exit(0); }
    if (!await exists(path)) process.exit(22);
    source = path;
  }
  const main = `https://raw.githubusercontent.com/${REPOSITORY}/main/`;
  const cli = new RegExp(`^https://github\\.com/${REPOSITORY}/releases/download/release-[a-f0-9]{64}/${cliAsset}$`, 'u');
  source ??= url === `${main}current.json` ? join(env.VIRGO_TEST_FILES, 'current.json') : url === `${main}launcher.js` ? env.VIRGO_TEST_LAUNCHER
    : url === `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bunPackage}.zip` ? join(env.VIRGO_TEST_FILES, 'bun.zip')
    : cliAsset && cli.test(url) ? join(env.VIRGO_TEST_FILES, 'current cli') : null;
  if (!source) process.exit(94);
  let bytes = await readFile(source);
  if (env.VIRGO_TEST_TAMPER && url.includes(env.VIRGO_TEST_TAMPER)) bytes = Buffer.concat([bytes, Buffer.from('tamper')]);
  await writeFile(out, bytes);
}
