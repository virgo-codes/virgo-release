import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// This is a caller-boundary acquisition test, with real Linux Bun and isolated
// HTTPS fixtures. Supply the already verified publisher archive; no test fetch.
if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || !process.env.VIRGO_TEST_BUN_ARCHIVE)
  throw new Error('Run on Linux x64 or arm64 with VIRGO_TEST_BUN_ARCHIVE naming the pinned Bun 1.3.14 zip.');
const arm64 = process.arch === 'arm64';
const bunPackage = arm64 ? 'bun-linux-aarch64' : 'bun-linux-x64';
const archiveSha = arm64 ? 'a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b' : '951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f';
const otherRuntimeSha = arm64 ? '9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74' : '37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086';
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'virgo-linux-acquisition-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
    : JSON.stringify(value);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const release = 'a'.repeat(64), other = 'b'.repeat(64);
const archive = await readFile(process.env.VIRGO_TEST_BUN_ARCHIVE);
if (sha(archive) !== archiveSha) throw new Error('Wrong Linux Bun fixture archive.');
let checks = 0;
try {
  const home = join(root, 'fresh user'), fixtures = join(root, 'fixtures'), bin = join(root, 'bin');
  await Promise.all([home, fixtures, bin].map(path => mkdir(path)));
  await writeFile(join(fixtures, 'bun.zip'), archive);
  const launcher = await readFile(join(repository, 'launcher.js'));
  await writeFile(join(fixtures, 'launcher.js'), launcher);
  const dispatch = join(root, 'dispatch.json');
  // Exercise the plain install's selected operator against a compatibility-bound
  // manifest. An argv-only recorder missed the published legacy operator bug.
  // This is the product's canonical digest contract, not Host activation.
  const cli = Buffer.from(`import { createHash } from 'node:crypto';
const canonical = ${canonical.toString()};
if (process.argv[2] === 'install') {
  const manifest = await Bun.file(process.env.VIRGO_TEST_RELEASE_MANIFEST).json();
  const { release, artifacts, compatibility } = manifest;
  const input = { release, artifacts, ...(!process.env.VIRGO_TEST_LEGACY_OPERATOR && compatibility !== undefined ? { compatibility } : {}) };
  if (createHash('sha256').update(canonical(input)).digest('hex') !== manifest.manifestDigest) {
    console.log(JSON.stringify({ ok: false, error: 'Release manifest digest failed.' })); process.exit(2);
  }
}
await Bun.write(process.env.VIRGO_TEST_DISPATCH,JSON.stringify(process.argv.slice(2)));\n`);
  await writeFile(join(fixtures, 'cli'), cli);
  const linux = { platform: { os: 'linux', architecture: process.arch }, release, cliSha256: sha(cli), operator: { release, cliSha256: sha(cli) } };
  const metadata = { sourceRepository: 'virgo-codes/virgo', launcherSha256: sha(launcher), platforms: [
    { ...linux, platform: { os: 'macos', architecture: 'arm64' }, release: other },
    { ...linux, platform: { os: 'linux', architecture: arm64 ? 'x64' : 'arm64' }, release: other }, linux] };
  await writeFile(join(fixtures, 'current.json'), JSON.stringify(metadata));
  const manifestPath = join(fixtures, 'release.json');
  const manifest = { release, artifacts: [], compatibility: { hubProtocol: { readable: { minimum: 1, maximum: 2 }, writes: 2 } } };
  manifest.manifestDigest = sha(canonical(manifest));
  await writeFile(manifestPath, JSON.stringify(manifest));
  const downloader = join(root, 'download.js');
  await writeFile(downloader, `import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';
const a=process.argv.slice(2),url=a.at(-3),out=a.at(-1);
const file=url.endsWith('/current.json')?'current.json':url.endsWith('/launcher.js')?'launcher.js':url.endsWith('/${bunPackage}.zip')?'bun.zip':url.endsWith('/release-${release}/virgo-linux-${process.arch}')?'cli':null;
if(!file||a.at(-2)!=='--output')process.exit(94);
let b=await readFile(join(process.env.VIRGO_TEST_FIXTURES,file));if(process.env.VIRGO_TEST_TAMPER===file)b=Buffer.concat([b,Buffer.from('tamper')]);await writeFile(out,b);\n`);
  await writeFile(join(bin, 'curl'), `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(downloader)} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, SHELL: '/bin/bash', PATH: `${bin}:/usr/bin:/bin`, VIRGO_TEST_FIXTURES: fixtures, VIRGO_TEST_DISPATCH: dispatch, VIRGO_TEST_RELEASE_MANIFEST: manifestPath };
  const run = (file, args, extra = {}, expected = 0) => {
    const result = spawnSync(file, args, { env: { ...env, ...extra }, encoding: 'utf8' });
    if (result.error || (expected === 0 ? result.status !== 0 : result.status === 0)) throw new Error(JSON.stringify(result));
    checks++; return result;
  };
  const installer = join(repository, 'install.sh'), virgo = join(home, '.local/bin/virgo');
  run('/bin/bash', [installer], { VIRGO_TEST_TAMPER: 'bun.zip' }, 1);
  if (await stat(virgo).catch(() => null)) throw new Error('Wrong Bun archive published a command.');
  run('/bin/bash', [installer], { VIRGO_TEST_TAMPER: 'cli' }, 1);
  if (await stat(virgo).catch(() => null)) throw new Error('Failed acquisition published a command.');
  run('/bin/bash', [installer]);
  run(virgo, ['--help']);
  const installArgs = ['install', '--mode', 'host', '--machine', 'isolated', '--root', join(root, 'installation')];
  run(virgo, installArgs);
  if (JSON.stringify(JSON.parse(await readFile(dispatch))) !== JSON.stringify([...installArgs, '--release', release, '--github-repository', 'virgo-codes/virgo-release'])) throw new Error('Wrong platform release selection.');
  const legacy = run(virgo, installArgs, { VIRGO_TEST_LEGACY_OPERATOR: '1' }, 1);
  if (legacy.status !== 2 || legacy.stdout.trim() !== '{"ok":false,"error":"Release manifest digest failed."}') throw new Error('Legacy operator countercheck did not reproduce the reported digest failure.');
  await writeFile(manifestPath, JSON.stringify({ ...manifest, compatibility: { ...manifest.compatibility, changed: true } }));
  const corrupt = run(virgo, installArgs, {}, 1);
  if (corrupt.status !== 2 || !corrupt.stdout.includes('Release manifest digest failed.')) throw new Error('Compatibility tampering passed the install digest check.');
  await writeFile(manifestPath, JSON.stringify(manifest));
  run(virgo, installArgs);
  const runtime = join(home, '.local/share/virgo/bootstrap/bun/1.3.14/bin/bun'), before = await stat(runtime);
  run('/bin/bash', [installer]);
  if ((await stat(runtime)).ino !== before.ino) throw new Error('Repeat acquisition replaced Bun.');
  const configPath = join(home, '.local/share/virgo/bootstrap/config.json'), configBytes = await readFile(configPath);
  const config = JSON.parse(configBytes);
  await writeFile(configPath, JSON.stringify({ ...config, sha256: otherRuntimeSha }));
  run(virgo, ['--help'], {}, 1);
  await writeFile(configPath, configBytes);
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
  state.active.artifact.artifact.platform = { os: 'linux', architecture: arm64 ? 'x64' : 'arm64' };
  await writeFile(join(directory, 'installation-state.json'), JSON.stringify(state)); run(virgo, status, {}, 1);
  metadata.platforms.push(linux); await writeFile(join(fixtures, 'current.json'), JSON.stringify(metadata)); run(virgo, installArgs, {}, 1);
  console.log(`PASS: ${checks} Linux ${process.arch} acquisition, platform selection, installed dispatch, integrity and repeat checks; synthetic installation only.`);
} finally { await rm(root, { recursive: true, force: true }); }
