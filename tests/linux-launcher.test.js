import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cliAsset, publishRelease } from './fixture-curl.js';

// This is a caller-boundary acquisition test, with real Linux Bun and isolated
// HTTPS fixtures. Supply the already verified publisher archive; no test fetch.
if (process.platform !== 'linux' || process.arch !== 'x64' || !process.env.VIRGO_TEST_BUN_ARCHIVE)
  throw new Error('Run on Linux x64 with VIRGO_TEST_BUN_ARCHIVE naming the pinned Bun 1.3.14 zip.');
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'virgo-linux-acquisition-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const release = 'a'.repeat(64), other = 'b'.repeat(64);
const archive = await readFile(process.env.VIRGO_TEST_BUN_ARCHIVE);
if (sha(archive) !== '951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f') throw new Error('Wrong Linux Bun fixture archive.');
let checks = 0;
try {
  const home = join(root, 'fresh user'), fixtures = join(root, 'fixtures'), bin = join(root, 'bin');
  await Promise.all([home, fixtures, bin].map(path => mkdir(path)));
  await writeFile(join(fixtures, 'bun.zip'), archive);
  const launcher = await readFile(join(repository, 'launcher.js'));
  await writeFile(join(fixtures, 'launcher.js'), launcher);
  const dispatch = join(root, 'dispatch.json');
  const cli = Buffer.from(`await Bun.write(process.env.VIRGO_TEST_DISPATCH,JSON.stringify(process.argv.slice(2)));\n`);
  await writeFile(join(fixtures, 'current cli'), cli);
  // Only the selected Linux release is published; a wrong selection finds no target.
  const github = join(root, 'github api'); await publishRelease(github, release, cli);
  const linux = { platform: { os: 'linux', architecture: 'x64' }, release, cliSha256: sha(cli), operator: { release, cliSha256: sha(cli) } };
  const metadata = { sourceRepository: 'virgo-codes/virgo', launcherSha256: sha(launcher), platforms: [
    { ...linux, platform: { os: 'macos', architecture: 'arm64' }, release: other }, linux] };
  await writeFile(join(fixtures, 'current.json'), JSON.stringify(metadata));
  // The shared stub serves this runner's exact acquisition URLs and the fixture GitHub API (tests/fixture-curl.js).
  const downloader = join(repository, 'tests', 'fixture-curl.js');
  await writeFile(join(bin, 'curl'), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(downloader)} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash', PATH: `${bin}:/usr/bin:/bin`, VIRGO_TEST_FILES: fixtures, VIRGO_TEST_LAUNCHER: join(fixtures, 'launcher.js'),
    VIRGO_TEST_GITHUB: github, VIRGO_TEST_DOWNLOAD_LOG: join(root, 'download.jsonl'), VIRGO_TEST_DISPATCH: dispatch };
  const run = (file, args, extra = {}, expected = 0) => {
    const result = spawnSync(file, args, { env: { ...env, ...extra }, encoding: 'utf8' });
    if (result.error || (expected === 0 ? result.status !== 0 : result.status === 0)) throw new Error(JSON.stringify(result));
    checks++; return result;
  };
  const installer = join(repository, 'install.sh'), virgo = join(home, '.local/bin/virgo');
  run('/bin/bash', [installer], { VIRGO_TEST_TAMPER: cliAsset }, 1);
  if (await stat(virgo).catch(() => null)) throw new Error('Failed acquisition published a command.');
  run('/bin/bash', [installer]);
  run(virgo, ['--help']);
  const installArgs = ['install', '--mode', 'host', '--machine', 'isolated', '--root', join(root, 'installation')];
  run(virgo, installArgs);
  if (JSON.stringify(JSON.parse(await readFile(dispatch))) !== JSON.stringify([...installArgs, '--release', release, '--github-repository', 'virgo-codes/virgo-release'])) throw new Error('Wrong platform release selection.');
  const runtime = join(home, '.local/share/virgo/bootstrap/bun/1.3.14/bin/bun'), before = await stat(runtime);
  run('/bin/bash', [installer]);
  if ((await stat(runtime)).ino !== before.ino) throw new Error('Repeat acquisition replaced Bun.');
  const wrapper = await readFile(virgo);
  run('/bin/bash', [installer], { VIRGO_TEST_TAMPER: 'launcher.js' }, 1);
  if (!wrapper.equals(await readFile(virgo))) throw new Error('Failed acquisition replaced the command.');

  // Exercise installed dispatch and its platform/supervisor fences, not just
  // download selection. These files are a synthetic installation, no daemon.
  const installedRoot = join(root, 'installed'), target = { machine: 'isolated', component: 'agent_host', instance: 'host' };
  const directory = join(installedRoot, 'instances', encodeURIComponent('isolated\0agent_host\0host'));
  const descriptor = Buffer.from(JSON.stringify({ release, daemonSupervision: { protocolVersion: 1, cliExecutable: 'bin/virgo' } }));
  const native = { schemaVersion: 1, release, component: 'agent_host', platform: linux.platform,
    entries: [['bin/virgo', cli], ['release.json', descriptor]].map(([path, bytes]) => ({ path, kind: 'file', mode: 0o755, digest: sha(bytes), content: bytes.toString('base64') })) };
  const bytes = Buffer.from(JSON.stringify(native)), digest = sha(bytes);
  const releaseDirectory = join(installedRoot, 'releases', `${release}-${digest}`), handle = join(installedRoot, 'cache', digest);
  const registration = join(installedRoot, 'processes/supervision/registration');
  for (const path of [directory, join(releaseDirectory, 'bin'), dirname(handle), registration]) await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(releaseDirectory, 'bin/virgo'), cli); await writeFile(join(releaseDirectory, 'release.json'), descriptor);
  await writeFile(handle, bytes, { mode: 0o600 });
  await writeFile(join(directory, 'virgo.config.json'), JSON.stringify({ schemaVersion: 1, machine: target.machine, release, mode: 'host' }), { mode: 0o600 });
  const state = { schemaVersion: 1, target, installedRelease: release, active: { releaseDirectory, artifact: { handle,
    artifact: { release, component: 'agent_host', platform: linux.platform, format: 'native_archive', digest } } } };
  await writeFile(join(directory, 'installation-state.json'), JSON.stringify(state), { mode: 0o600 });
  const info = await stat(runtime);
  const receipt = { schemaVersion: 1, root: installedRoot, releaseDirectory, cli: join(releaseDirectory, 'bin/virgo'), cliDigest: sha(cli),
    executable: runtime, executableIdentity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`, launchAgentsDirectory: join(home, '.config/systemd/user'), intervalSeconds: 5 };
  const receiptPath = join(registration, 'supervisor.json'); await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const status = ['--directory', directory, 'host', 'status']; run(virgo, status);
  if (JSON.stringify(JSON.parse(await readFile(dispatch))) !== JSON.stringify(status)) throw new Error('Installed dispatch changed arguments.');
  await writeFile(receiptPath, JSON.stringify({ ...receipt, launchAgentsDirectory: join(home, 'Library/LaunchAgents') }));
  run(virgo, status, {}, 1); await writeFile(receiptPath, JSON.stringify(receipt));
  state.active.artifact.artifact.platform = { os: 'macos', architecture: 'arm64' };
  await writeFile(join(directory, 'installation-state.json'), JSON.stringify(state)); run(virgo, status, {}, 1);
  metadata.platforms.push(linux); await writeFile(join(fixtures, 'current.json'), JSON.stringify(metadata)); run(virgo, installArgs, {}, 1);
  console.log(`PASS: ${checks} Linux acquisition, platform selection, installed dispatch, integrity and repeat checks; synthetic installation only.`);
} finally { await rm(root, { recursive: true, force: true }); }
