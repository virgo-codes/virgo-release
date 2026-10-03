import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(await import('node:fs/promises').then(m => m.realpath(tmpdir())), 'virgo-launcher-test-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const newer = 'b'.repeat(64), older = 'a'.repeat(64);
const fixtureDir = join(root, 'official files with spaces'), bin = join(root, 'fixture bin');
await mkdir(fixtureDir, { recursive: true }); await mkdir(bin);
const metadataPath = join(fixtureDir, 'current.json');
const launcherPath = join(repository, 'launcher.js');
const assetPath = join(fixtureDir, 'current cli');
const dispatchLog = join(root, 'dispatch.json');
const downloadLog = join(root, 'download.jsonl');
const environment = { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/zsh',
  VIRGO_TEST_FILES: fixtureDir, VIRGO_TEST_LAUNCHER: launcherPath, VIRGO_TEST_DISPATCH: dispatchLog, VIRGO_TEST_DOWNLOAD_LOG: downloadLog };
const cli = marker => `#!/unusable/interpreter\nawait Bun.write(process.env.VIRGO_TEST_DISPATCH,JSON.stringify({marker:${JSON.stringify(marker)},args:process.argv.slice(2)}));\nconsole.log(JSON.stringify({ok:true,marker:${JSON.stringify(marker)}}));\nprocess.exit(Number(process.env.VIRGO_TEST_CLI_EXIT??0));\n`;
await writeFile(assetPath, cli('current'));
const current = { ...await Bun.file(join(repository, 'current.json')).json(), release: newer, cliSha256: sha(await readFile(assetPath)), launcherSha256: sha(await readFile(launcherPath)) };
await writeFile(metadataPath, JSON.stringify(current));
const runtime = join(fixtureDir, 'bun-darwin-aarch64'); await mkdir(runtime);
await copyFile(process.execPath, join(runtime, 'bun'));
const zip = join(fixtureDir, 'bun.zip');
if (spawnSync('/usr/bin/zip', ['-q', '-r', zip, 'bun-darwin-aarch64'], { cwd: fixtureDir }).status !== 0) throw new Error('Could not prepare isolated runtime archive.');
let installer = await readFile(join(repository, 'install.sh'), 'utf8');
installer = installer.replace(/readonly BUN_ARCHIVE_SHA='[a-f0-9]+'/u, `readonly BUN_ARCHIVE_SHA='${sha(await readFile(zip))}'`)
  .replace(/readonly BUN_SHA='[a-f0-9]+'/u, `readonly BUN_SHA='${sha(await readFile(process.execPath))}'`);
const installerPath = join(fixtureDir, 'install.sh'); await writeFile(installerPath, installer);
const downloader = join(root, 'download.js');
await writeFile(downloader, `import{readFile,writeFile,appendFile}from'node:fs/promises';import{join}from'node:path';
const args=process.argv.slice(2),url=args.at(-3),out=args.at(-1);await appendFile(process.env.VIRGO_TEST_DOWNLOAD_LOG,JSON.stringify(args)+'\\n');
if(args.at(-2)!=='--output'||!url.startsWith('https://'))process.exit(93);
if(process.env.VIRGO_TEST_FAIL&&url.includes(process.env.VIRGO_TEST_FAIL))process.exit(23);
if(process.env.VIRGO_TEST_INTERRUPT&&url.includes(process.env.VIRGO_TEST_INTERRUPT)){process.kill(process.ppid,'SIGTERM');process.exit(143);}
let source=url.endsWith('/current.json')?join(process.env.VIRGO_TEST_FILES,'current.json'):url.endsWith('/launcher.js')?process.env.VIRGO_TEST_LAUNCHER:url.endsWith('/bun-darwin-aarch64.zip')?join(process.env.VIRGO_TEST_FILES,'bun.zip'):url.endsWith('/virgo-macos-arm64')?join(process.env.VIRGO_TEST_FILES,'current cli'):null;if(!source)process.exit(94);
let bytes=await readFile(source);if(process.env.VIRGO_TEST_TAMPER&&url.includes(process.env.VIRGO_TEST_TAMPER))bytes=Buffer.concat([bytes,Buffer.from('tamper')]);await writeFile(out,bytes);`);
await writeFile(join(bin, 'curl'), `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(downloader)} "$@"\n`, { mode: 0o700 });
await writeFile(join(bin, 'gh'), '#!/bin/bash\nexit 91\n', { mode: 0o700 });
let cases = 0;
function command(executable, args, env = environment) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
function success(result) { if (result.status !== 0) throw new Error(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr })); cases++; return result; }
function rejected(result, contains) { if (result.status === 0 || (contains && !result.stderr.includes(contains))) throw new Error(JSON.stringify(result)); cases++; return result; }
async function dispatch(expectedMarker, args) {
  const actual = JSON.parse(await readFile(dispatchLog, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify({ marker: expectedMarker, args })) throw new Error(JSON.stringify({ actual, expectedMarker, args }));
}
async function installedFixture(installationRoot, release, marker, instance = 'host', cliBytes = Buffer.from(cli(marker))) {
  const target = { machine: 'isolated', component: 'agent_host', instance };
  const directory = join(installationRoot, 'instances', encodeURIComponent(`${target.machine}\0agent_host\0${instance}`));
  const descriptor = Buffer.from(JSON.stringify({ release, adapterDirectory: 'adapters' })+'\n');
  const archive = { schemaVersion: 1, component: 'agent_host', release, platform: { os: 'macos', architecture: 'arm64' },
    entries: [['bin/virgo', cliBytes], ['release.json', descriptor]].map(([path, bytes]) => ({ path, kind: 'file', mode: 0o755, digest: sha(bytes), content: bytes.toString('base64') })) };
  const archiveBytes = Buffer.from(JSON.stringify(archive)+'\n'), digest = sha(archiveBytes);
  const releaseDirectory = join(installationRoot, 'releases', `${release}-${digest}`), handle = join(installationRoot, 'cache', digest);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(join(releaseDirectory, 'bin'), { recursive: true }); await mkdir(dirname(handle), { recursive: true });
  await writeFile(join(releaseDirectory, 'bin', 'virgo'), cliBytes, { mode: 0o555 }); await writeFile(join(releaseDirectory, 'release.json'), descriptor, { mode: 0o444 });
  await writeFile(handle, archiveBytes, { mode: 0o600 });
  await writeFile(join(directory, 'virgo.config.json'), JSON.stringify({ schemaVersion: 1, machine: target.machine, release }), { mode: 0o600 });
  await writeFile(join(directory, 'installation-state.json'), JSON.stringify({ schemaVersion: 1, target, installedRelease: release,
    active: { releaseDirectory, artifact: { handle, artifact: { component: 'agent_host', release, platform: archive.platform, format: 'native_archive', digest } } } }), { mode: 0o600 });
  return { directory, releaseDirectory, handle };
}
try {
  const coldHome = join(root, 'interrupted first acquisition'); await mkdir(coldHome);
  rejected(command('/bin/bash', [installerPath], { ...environment, HOME: coldHome, VIRGO_TEST_TAMPER: 'virgo-macos-arm64' }));
  for (const missing of [join(coldHome,'.local','bin','virgo'),join(coldHome,'.zprofile')]) {
    try { await readFile(missing); throw new Error('Failed cold acquisition published a partial command/profile.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  success(command('/bin/bash', [installerPath], { ...environment, HOME: coldHome }));
  success(command('/bin/zsh', ['-l','-c','virgo --help'], { ...environment, HOME: coldHome }));
  const home = join(root, 'fresh user with spaces'); await mkdir(home);
  const env = { ...environment, HOME: home }, virgo = join(home, '.local', 'bin', 'virgo');
  await writeFile(join(home, '.zprofile'), '# retained operator profile\nexport RETAINED_VIRGO_TEST=yes\n');
  if (command('/bin/bash', ['-c', 'command -v bun'], env).status === 0) throw new Error('Fixture unexpectedly has external Bun.');
  success(command('/bin/bash', [installerPath], env));
  const profile = await readFile(join(home, '.zprofile'), 'utf8');
  if (!profile.startsWith('# retained operator profile\nexport RETAINED_VIRGO_TEST=yes\n') || !profile.includes('# Virgo public command')) throw new Error('Profile content was not preserved.');
  // The new login shell loads the actual generated profile; no PATH export is taught to the user.
  success(command('/bin/zsh', ['-l', '-c', 'command -v virgo; virgo --help'], env));
  success(command(virgo, ['--help'], env));
  success(command(virgo, ['install', '--mode', 'local', '--machine', 'local', '--root', join(root, 'install root')], env));
  await dispatch('current', ['install', '--mode', 'local', '--machine', 'local', '--root', join(root, 'install root'), '--release', newer, '--github-repository', 'virgo-codes/virgo-release']);
  const quoted = join(root, 'root $(touch never-run) `quoted` *');
  const installArgs = ['install', '--mode', 'host', '--root', quoted, '--machine', 'host', '--hub-url', 'https://hub.example/', '--enrollment-credential-file', join(root, 'credential with spaces')];
  success(command(virgo, installArgs, env));
  await dispatch('current', [...installArgs, '--release', newer, '--github-repository', 'virgo-codes/virgo-release']);
  success(command(virgo, ['upgrade', '--mode', 'host', '--machine', 'host', '--root', quoted, '--activate', 'false'], env));
  await dispatch('current', ['upgrade', '--mode', 'host', '--machine', 'host', '--root', quoted, '--activate', 'false', '--release', newer, '--github-repository', 'virgo-codes/virgo-release']);
  success(command(virgo, ['upgrade', '--mode', 'local', '--machine', 'local'], env));
  for (const distro of ['--github-repository', '--manifest-directory', '--bundle']) {
    const args = ['upgrade', '--mode', 'host', '--machine', 'host', '--release', older, distro, distro === '--github-repository' ? 'virgo-codes/virgo-release' : join(root, 'recovery distribution')];
    success(command(virgo, args, env)); await dispatch('current', args);
  }
  const target = await installedFixture(join(root, 'old installed root'), older, 'old');
  const installedArgs = ['--directory', target.directory, 'agent', 'status', 'vsp:/example:space/repo/lead', '--value', 'literal $(touch never-run) `quoted` *'];
  await rm(downloadLog, { force: true });
  success(command(virgo, installedArgs, { ...env, VIRGO_TEST_FAIL: 'current.json' })); await dispatch('old', installedArgs);
  try { await readFile(downloadLog); throw new Error('Installed dispatch unexpectedly contacted current metadata.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const hostRollback = ['rollback', '--mode', 'host', '--machine', 'isolated', '--root', join(root, 'old installed root'), '--plan-id', 'retained-plan'];
  success(command(virgo, hostRollback, env)); await dispatch('old', hostRollback);
  const localRoot = join(root, 'local retained root'); await installedFixture(localRoot, older, 'old-local', 'local-hub');
  const localRollback = ['rollback', '--mode', 'local', '--machine', 'isolated', '--root', localRoot, '--plan-id', 'retained-plan', '--manifest-directory', join(localRoot, 'cache')];
  success(command(virgo, localRollback, env)); await dispatch('old-local', localRollback);
  const beforeState = await readFile(join(target.directory, 'installation-state.json'));
  for (const path of [join(target.releaseDirectory, 'bin', 'virgo'), join(target.releaseDirectory, 'release.json'), target.handle]) {
    const before = await readFile(path); await chmod(path, 0o600); await writeFile(path, Buffer.concat([before, Buffer.from('tamper')]));
    rejected(command(virgo, ['--directory', target.directory, 'host', 'status'], env), 'checksum');
    await writeFile(path, before);
  }
  if (!beforeState.equals(await readFile(join(target.directory, 'installation-state.json')))) throw new Error('Installed dispatch changed runtime state.');
  success(command(virgo, installedArgs, env)); await dispatch('old', installedArgs);
  for (const args of [ ['upgrade','--machine','host'], ['install','--machine','x','--root','relative'], ['install','--machine','x','--machine','y'],
    ['upgrade','--mode','host','--machine','x','--release',older], ['install','--machine','x','--bundle','/tmp'], ['install','--machine','x','--release=bad'],
    ['rollback','--mode','host','--machine','x','--plan-id','p','--github-repository','o/r'], ['rollback','--mode','local','--machine','x','--plan-id','p'] ]) {
    await rm(downloadLog, { force: true }); rejected(command(virgo, args, env));
    try { await readFile(downloadLog); throw new Error('Malformed operation downloaded before validation.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const oldWrapper = await readFile(virgo), oldProfile = await readFile(join(home, '.zprofile'));
  for (const behavior of [{ VIRGO_TEST_FAIL: 'bun-darwin-aarch64.zip' }, { VIRGO_TEST_TAMPER: 'launcher.js' }, { VIRGO_TEST_TAMPER: 'bun-darwin-aarch64.zip' }, { VIRGO_TEST_INTERRUPT: 'bun-darwin-aarch64.zip' }]) {
    rejected(command('/bin/bash', [installerPath], { ...env, ...behavior }));
    if (!oldWrapper.equals(await readFile(virgo)) || !oldProfile.equals(await readFile(join(home, '.zprofile')))) throw new Error('Failed acquisition replaced the previous command/profile.');
    success(command(virgo, ['--help'], env));
  }
  // A new selected CLI fails download/checksum before caller dispatch, retaining the installed target.
  const changed = cli('successor'); await writeFile(assetPath, changed); current.release = 'c'.repeat(64); current.cliSha256 = sha(changed); await writeFile(metadataPath, JSON.stringify(current));
  rejected(command(virgo, ['upgrade','--mode','host','--machine','host'], { ...env, VIRGO_TEST_FAIL: 'virgo-macos-arm64' }));
  rejected(command(virgo, ['upgrade','--mode','host','--machine','host'], { ...env, VIRGO_TEST_TAMPER: 'virgo-macos-arm64' }), 'checksum');
  if (!beforeState.equals(await readFile(join(target.directory, 'installation-state.json')))) throw new Error('Failed upgrade modified the old installation.');
  success(command(virgo, ['upgrade','--mode','host','--machine','host'], env));
  await dispatch('successor', ['upgrade','--mode','host','--machine','host','--release',current.release,'--github-repository','virgo-codes/virgo-release']);
  success(command(virgo, installedArgs, env)); await dispatch('old', installedArgs);
  const forwarded = command(virgo, ['install','--machine','exit-test'], { ...env, VIRGO_TEST_CLI_EXIT: '7' });
  if (forwarded.status !== 7) throw new Error('CLI exit status changed.'); cases++;
  success(command('/bin/bash', [installerPath], env));
  if (!oldProfile.equals(await readFile(join(home, '.zprofile')))) throw new Error('Repeat acquisition duplicated profile content.');
  success(command('/bin/zsh', ['-l','-c','virgo --help'], env));
  const bashHome = join(root, 'bash user'); await mkdir(bashHome);
  success(command('/bin/bash', [installerPath], { ...environment, HOME: bashHome, SHELL: '/bin/bash' }));
  success(command('/bin/bash', ['-l','-c','virgo --help'], { ...environment, HOME: bashHome, SHELL: '/bin/bash' }));
  console.log(`PASS: ${cases} composed acquisition/PATH/install/upgrade/recovery/installed-dispatch/failure/retry checks; real Bash/zsh/Bun, isolated HTTPS fixtures, no live Hub/Host/provider effects.`);
} finally { await rm(root, { recursive: true, force: true }); }
