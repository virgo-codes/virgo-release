// Thin-Host launcher routes (new Hub, L4 client-main dispatch):
//   virgo thin-host install ...                       -> current operator CLI
//   virgo --directory <thin-root> thin-host start|stop|status -> the thin Host's
//     verified installed release CLI
// Every other argv returns undefined, so the legacy dispatch stays unchanged.
// argv -> launcher -> selected binary path and args, with fake exec and
// runtime/current-pin resolution; one case runs the real installed-release
// verification on the exact layout and thin-host.json `virgo thin-host install`
// writes (thinHostInstall below, ported from L4 runtime/thin-host/cli.ts) and on
// a tampered copy. Section 6 runs
// the actual public entry (bun launcher.js <argv>) as a subprocess against a
// temp HOME with the pinned-runtime fixture, a stub curl (tests/fixture-curl.js)
// and recording CLIs; nothing leaves the temp directory and no network is used.
// Run: bun tests/thin-host-dispatch.test.js
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, chmod, copyFile, lstat, symlink, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { platform as fixturePlatform } from './fixture-curl.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(await realpath(tmpdir()), 'virgo-thin-dispatch-'));
process.env.VIRGO_LAUNCHER_STATE = join(root, 'launcher-state');
const { thinHostRoute, thinHostDefaults } = await import(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'launcher.js'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let cases = 0;
const equal = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  cases++;
};
const rejects = async (promise, pattern, label) => {
  try { await promise; } catch (error) { if (pattern.test(error.message)) { cases++; return; } throw new Error(`${label}: ${error.message}`); }
  throw new Error(`${label}: did not fail`);
};

const BUN = '/fixture/bootstrap/bun', OPERATOR = '/fixture/launcher/releases/op/virgo', THIN_CLI = '/fixture/home/virgo/releases/r-d/bin/virgo';
function fakes(overrides = {}) {
  const calls = [];
  return { calls, dependencies: {
    run: async (executable, args) => { calls.push({ executable, args }); return 0; },
    configuredRuntime: async () => ({ executable: BUN }),
    currentCLI: async (supplied, operator) => { calls.push({ currentCLI: { supplied, operator } }); return { path: OPERATOR, current: {} }; },
    thinHostCLI: async directory => { calls.push({ thinHostCLI: directory }); return { path: THIN_CLI }; },
    present: async path => path === '/thin/root/thin-host.json',
    ...overrides,
  } };
}

try {
  // 1. Top-level thin-host install -> verified current OPERATOR CLI, argv passed through unchanged.
  {
    const { calls, dependencies } = fakes();
    const argv = ['thin-host', 'install', '--machine', 'nuptse', '--hub-url', 'https://hub.example.test/', '--hub-audience', 'virgo-hub'];
    equal(await thinHostRoute(argv, dependencies), 0, 'install exit');
    equal(calls, [{ currentCLI: { supplied: undefined, operator: true } }, { executable: BUN, args: [OPERATOR, ...argv] }], 'install dispatch');
  }
  // 2. --directory <thin-root> thin-host start|stop|status -> thin Host's verified release CLI.
  //    "/root/." and "/root/" are the same root: verified as /thin/root, ORIGINAL argv passed on.
  for (const [operation, directory] of [['start', '/thin/root'], ['stop', '/thin/root'], ['status', '/thin/root'], ['status', '/thin/root/.'], ['start', '/thin/root/']]) {
    const { calls, dependencies } = fakes();
    const argv = ['--directory', directory, 'thin-host', operation];
    equal(await thinHostRoute(argv, dependencies), 0, `${operation} ${directory} exit`);
    equal(calls, [{ thinHostCLI: '/thin/root' }, { executable: BUN, args: [THIN_CLI, ...argv] }], `${operation} ${directory} dispatch`);
  }
  // 3. Everything else is left to the unchanged legacy dispatch (no exec, no resolution).
  for (const argv of [
    ['--directory', '/legacy/instance', 'thin-host', 'start'], // no thin-host.json
    ['--directory', '/thin/root', 'host', 'status'],
    ['--directory', '/thin/root', 'thin-host', 'restart'],
    ['--directory', '/thin/root', 'thin-host', 'start', '--extra'],
    ['--directory', 'relative', 'thin-host', 'start'],
    ['install', '--mode', 'host', '--machine', 'nuptse'],
    ['upgrade', '--mode', 'host', '--machine', 'nuptse'],
    ['rollback', '--mode', 'host', '--machine', 'nuptse', '--plan-id', 'p'],
  ]) {
    const { calls, dependencies } = fakes();
    equal(await thinHostRoute(argv, dependencies), undefined, `legacy ${argv.join(' ')}`);
    equal(calls, [], `legacy calls ${argv.join(' ')}`);
  }
  // 4. Malformed thin-host top-level commands refuse before any resolution or exec.
  for (const argv of [['thin-host', 'start'], ['thin-host', 'install', '--machine'], ['thin-host', 'install', '--machine', 'a', '--machine', 'b']]) {
    const { calls, dependencies } = fakes();
    await rejects(thinHostRoute(argv, dependencies), /thin-host|unique --name value/u, `refuse ${argv.join(' ')}`);
    equal(calls, [], `refuse calls ${argv.join(' ')}`);
  }
  // 5. Real verification against the real install output: <root>/cache/<d>, <root>/releases/<r>-<d>,
  //    <root>/release/current and thin-host.json exactly as L4 install writes them (no releaseRoot field).
  {
    const { thin, releaseDirectory, config } = await thinHostInstall(join(root, 'home'), '#!/usr/bin/env bun\nconsole.log("cli")\n');
    equal(Object.keys(config), ['hub', 'hubAudience', 'keypairPath', 'associationPath', 'instanceRoot', 'stateDirectory', 'releaseDirectory', 'memoryHook', 'cli'], 'L4 config fields');
    // Real launcher verification (thinHostDefaults.thinHostCLI); only exec, runtime and current pin are fakes.
    const { calls, dependencies } = fakes();
    const verifying = { ...thinHostDefaults, run: dependencies.run, configuredRuntime: dependencies.configuredRuntime, currentCLI: dependencies.currentCLI };
    for (const directory of [thin, `${thin}/.`, `${thin}/`]) {
      calls.length = 0;
      equal(await thinHostRoute(['--directory', directory, 'thin-host', 'status'], verifying), 0, `verified exit ${directory}`);
      equal(calls, [{ executable: BUN, args: [join(releaseDirectory, 'bin', 'virgo'), '--directory', directory, 'thin-host', 'status'] }], `verified release dispatch ${directory}`);
    }
    // Without release/current the recorded releaseDirectory is used (L4 supervisedExecutable order).
    const current = join(thin, 'release', 'current'), target = await realpath(current);
    await rm(current); calls.length = 0;
    equal(await thinHostRoute(['--directory', thin, 'thin-host', 'start'], verifying), 0, 'recorded releaseDirectory exit');
    equal(calls, [{ executable: BUN, args: [join(releaseDirectory, 'bin', 'virgo'), '--directory', thin, 'thin-host', 'start'] }], 'recorded releaseDirectory dispatch');
    await symlink(target, current);
    // Tampered packaged thin-Host executable: refused, nothing executed.
    await chmod(join(releaseDirectory, 'bin'), 0o755); await chmod(join(releaseDirectory, 'bin', 'virgo-thin-host'), 0o755);
    await writeFile(join(releaseDirectory, 'bin', 'virgo-thin-host'), '#!/usr/bin/env bun\nconsole.log("tampered")\n', { mode: 0o755 });
    calls.length = 0;
    await rejects(thinHostRoute(['--directory', thin, 'thin-host', 'start'], verifying), /checksum failed/u, 'tampered thin host');
    equal(calls, [], 'tampered not executed');
  }
  // 6. The public entry: `bun launcher.js <argv>` in a subprocess.
  if (!fixturePlatform) console.log(JSON.stringify({ skipped: 'subprocess entry', reason: 'fixture-curl serves macOS arm64 and Linux x64 only' }));
  else {
    const sub = join(root, 'entry'), home = join(sub, 'home'), files = join(sub, 'files'), bin = join(sub, 'fixture bin'), dispatch = join(sub, 'dispatch.jsonl');
    await mkdir(files, { recursive: true }); await mkdir(bin); await mkdir(home, { mode: 0o755 });
    // Pinned configured runtime, as the official acquisition leaves it: the test's own Bun under its own digest.
    const bunBytes = await readFile(process.execPath), bunSha = sha(bunBytes);
    const runtime = join(home, '.local/share/virgo/bootstrap/bun/1.3.14/bin/bun');
    await mkdir(dirname(runtime), { recursive: true, mode: 0o755 }); await copyFile(process.execPath, runtime); await chmod(runtime, 0o755);
    const info = await lstat(runtime);
    await writeFile(join(home, '.local/share/virgo/bootstrap/config.json'), JSON.stringify({ schemaVersion: 1, bunVersion: '1.3.14', executable: runtime, sha256: bunSha,
      identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` }), { mode: 0o600 });
    // Only the runtime pins change, exactly as tests/target-dispatch.test.js does.
    const launcher = (await readFile(join(repository, 'launcher.js'), 'utf8'))
      .replace(/const BUN_SHA = '[a-f0-9]+';/u, `const BUN_SHA = '${bunSha}';`)
      .replace(/const RUNTIME_SHA = [\s\S]*?;\n/u, block => block.replace(/'[a-f0-9]{64}'/gu, `'${bunSha}'`));
    const launcherPath = join(files, 'launcher.js'); await writeFile(launcherPath, launcher);
    const recording = marker => `import{appendFileSync}from'node:fs';appendFileSync(process.env.VIRGO_TEST_DISPATCH,JSON.stringify({marker:${JSON.stringify(marker)},args:process.argv.slice(2)})+'\\n');\n`;
    const operatorCli = Buffer.from(recording('operator')), operatorRelease = 'e'.repeat(64);
    await writeFile(join(files, 'current cli'), operatorCli);
    const pin = { platform: fixturePlatform, release: operatorRelease, cliSha256: sha(operatorCli), operator: { release: operatorRelease, cliSha256: sha(operatorCli) } };
    await writeFile(join(files, 'current.json'), JSON.stringify({ sourceRepository: 'virgo-codes/virgo', platforms: [pin] }));
    await writeFile(join(bin, 'curl'), `#!/bin/bash\nexec '${process.execPath}' '${join(repository, 'tests', 'fixture-curl.js')}' "$@"\n`, { mode: 0o700 });
    const { thin } = await thinHostInstall(home, recording('thin-release'));
    const legacyRoot = join(home, 'not-a-thin-host'); await mkdir(legacyRoot, { mode: 0o755 });
    const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, VIRGO_LAUNCHER_STATE: join(sub, 'launcher-state'),
      VIRGO_TEST_FILES: files, VIRGO_TEST_DOWNLOAD_LOG: join(sub, 'download.jsonl'), VIRGO_TEST_DISPATCH: dispatch };
    const entry = argv => spawnSync(process.execPath, [launcherPath, ...argv], { env, encoding: 'utf8' });
    const dispatched = async () => { try { return (await readFile(dispatch, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
    const install = ['thin-host', 'install', '--machine', 'nuptse', '--hub-url', 'https://hub.example.test/', '--hub-audience', 'virgo-hub'];
    let result = entry(install);
    equal([result.status, result.stderr], [0, ''], 'entry install exit');
    equal(await dispatched(), [{ marker: 'operator', args: install }], 'entry install -> verified current operator CLI');
    for (const [operation, directory] of [['start', thin], ['status', thin], ['stop', thin], ['status', `${thin}/.`], ['status', `${thin}/`]]) {
      await rm(dispatch, { force: true });
      result = entry(['--directory', directory, 'thin-host', operation]);
      equal([result.status, result.stderr], [0, ''], `entry ${operation} exit ${directory}`);
      equal(await dispatched(), [{ marker: 'thin-release', args: ['--directory', directory, 'thin-host', operation] }], `entry ${operation} -> thin release CLI ${directory}`);
    }
    // Legacy argv keeps the legacy path: legacy refusals, nothing dispatched.
    await rm(dispatch, { force: true });
    result = entry(['upgrade', '--machine', 'nuptse']);
    equal([result.status, /--mode local or --mode host is required/u.test(result.stderr)], [1, true], 'entry legacy upgrade refusal');
    result = entry(['--directory', legacyRoot, 'thin-host', 'status']);
    equal([result.status, /Thin-Host/u.test(result.stderr)], [1, false], 'entry legacy --directory without thin-host.json');
    equal(await dispatched(), [], 'entry legacy dispatched nothing');
  }
  console.log(JSON.stringify({ ok: true, cases }));
} finally { await unseal(root); await rm(root, { recursive: true, force: true }); }

/** Sealed release trees are 0555 (L4 distribution/native-archive.ts:76-82); reopen them so cleanup can remove them. */
async function unseal(path) {
  let info; try { info = await lstat(path); } catch { return; }
  if (!info.isDirectory()) return;
  await chmod(path, 0o755);
  for (const name of await readdir(path)) await unseal(join(path, name));
}

/**
 * Reproduces what `virgo thin-host install` leaves on disk (L4 lane-l4-thin-host-20261107 @ 97d08920):
 *   root = <home>/virgo-thin-host, mkdir 0700                         runtime/thin-host/cli.ts:184,199
 *   <root>/cache/<archiveDigest>, dir 0700, file 0600                  runtime/install-main.ts:63; distribution/local-distribution.ts:99-100, github-release.ts:231-234
 *   <root>/releases/<release>-<archiveDigest>, extracted then sealed   runtime/thin-host/node-ports.ts:159-161,175-182; distribution/native-archive.ts:76-82,179-193
 *   <root>/release/current -> releases/<release>-<archiveDigest>       runtime/thin-host/node-ports.ts:165-172; cli.ts:143
 *   <root>/run, 0700                                                   runtime/thin-host/cli.ts:210
 *   <root>/thin-host.json, 0600, JSON.stringify(config, null, 2)+"\n" runtime/thin-host/cli.ts:106-108,202-209,211
 * The config object below is cli.ts:202-209 field for field (no --codex-executable); it has no releaseRoot.
 */
async function thinHostInstall(home, cliText) {
  const thin = join(home, 'virgo-thin-host'), release = 'c'.repeat(64), identity = join(home, 'virgo', 'instances', 'nuptse%00agent_host%00local', 'identity');
  const files = { 'bin/virgo': cliText, 'bin/virgo-thin-host': '#!/usr/bin/env bun\nconsole.log("thin")\n', 'release.json': `${JSON.stringify({ release })}\n` };
  const entries = [{ path: 'bin', kind: 'directory', mode: 0o755 }, ...Object.entries(files).map(([path, text]) => ({ path, kind: 'file',
    mode: path.startsWith('bin/') ? 0o755 : 0o644, digest: sha(Buffer.from(text)), content: Buffer.from(text).toString('base64') }))];
  const archive = JSON.stringify({ schemaVersion: 1, component: 'agent_host', release, platform: { os: process.platform === 'darwin' ? 'macos' : 'linux', architecture: process.arch }, entries });
  const archiveDigest = sha(Buffer.from(archive));
  await mkdir(thin, { recursive: true, mode: 0o700 });
  await mkdir(join(thin, 'cache'), { mode: 0o700 });
  await writeFile(join(thin, 'cache', archiveDigest), archive, { mode: 0o600 });
  const directory = join(thin, 'releases', `${release}-${archiveDigest}`);
  await mkdir(join(thin, 'releases'), { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
  for (const entry of entries) {
    if (entry.kind === 'directory') await mkdir(join(directory, entry.path), { mode: 0o700 });
    else await writeFile(join(directory, entry.path), Buffer.from(entry.content, 'base64'), { mode: entry.mode });
  }
  for (const entry of entries) await chmod(join(directory, entry.path), entry.kind === 'directory' ? 0o555 : (entry.mode & 0o111) === 0 ? 0o444 : 0o555);
  await chmod(directory, 0o555);
  await mkdir(join(thin, 'release'), { mode: 0o700 }); await symlink(directory, join(thin, 'release', 'current'));
  const releaseDirectory = await realpath(directory);
  const config = {
    hub: new URL('https://hub.example.test/').href, hubAudience: 'virgo-hub', keypairPath: join(identity, 'host-ed25519.pem'), associationPath: join(identity, 'association.json'), instanceRoot: thin,
    stateDirectory: join(thin, 'state'), releaseDirectory,
    memoryHook: { socketPath: join(thin, 'run', 'memory-hooks.sock'), providers: [] },
    cli: join(home, '.local', 'bin', 'virgo'),
  };
  await mkdir(join(thin, 'run'), { mode: 0o700 });
  await writeFile(join(thin, 'thin-host.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  for (const path of [root, home]) await chmod(path, 0o755);
  return { thin, releaseDirectory, config };
}
