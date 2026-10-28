import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, readdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// S289: an explicit `upgrade --release R` with one distribution runs R's own
// authenticated CLI, so R's checks govern an older installed Host. The older
// installed release and the independent current.operator stay pinned to a
// 2.2.1-class CLI which cannot decode a receipt written by a later release.
// Runs on macOS arm64, or on Linux x64 with VIRGO_TEST_BUN_ARCHIVE naming the
// pinned Bun 1.3.14 zip (as tests/linux-launcher.test.js).
const platform = process.platform === 'darwin' && process.arch === 'arm64' ? { os: 'macos', architecture: 'arm64' }
  : process.platform === 'linux' && process.arch === 'x64' ? { os: 'linux', architecture: 'x64' } : null;
if (!platform) throw new Error('Run on macOS arm64 or Linux x64.');
const linux = platform.os === 'linux';
if (linux && !process.env.VIRGO_TEST_BUN_ARCHIVE) throw new Error('On Linux x64, set VIRGO_TEST_BUN_ARCHIVE to the pinned Bun 1.3.14 zip.');
const foreign = linux ? { os: 'macos', architecture: 'arm64' } : { os: 'linux', architecture: 'x64' };
const bunPackage = linux ? 'bun-linux-x64' : 'bun-darwin-aarch64', cliAsset = `virgo-${platform.os}-${platform.architecture}`;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(await realpath(tmpdir()), 'virgo-target-dispatch-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const older = 'a'.repeat(64), target = 'f'.repeat(64), OFFICIAL = 'virgo-codes/virgo-release', UNOFFICIAL = 'virgo-codes/virgo';
const fixtureDir = join(root, 'official files'), github = join(root, 'github releases'), bin = join(root, 'fixture bin');
await mkdir(fixtureDir, { recursive: true }); await mkdir(github); await mkdir(bin);
const launcherPath = join(fixtureDir, 'launcher.js'), assetPath = join(fixtureDir, 'current cli'), zip = join(fixtureDir, 'bun.zip');
const dispatchLog = join(root, 'dispatch.json'), downloadLog = join(root, 'download.jsonl');
let launcher = await readFile(join(repository, 'launcher.js'), 'utf8'), installer = await readFile(join(repository, 'install.sh'), 'utf8');
if (linux) {
  await copyFile(process.env.VIRGO_TEST_BUN_ARCHIVE, zip);
  if (sha(await readFile(zip)) !== '951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f') throw new Error('Wrong Linux Bun fixture archive.');
} else {
  // macOS uses the test's own Bun under the same pins, as tests/launcher.test.js does.
  const runtime = join(fixtureDir, bunPackage); await mkdir(runtime); await copyFile(process.execPath, join(runtime, 'bun'));
  if (spawnSync('/usr/bin/zip', ['-q', '-r', zip, bunPackage], { cwd: fixtureDir }).status !== 0) throw new Error('Could not prepare isolated runtime archive.');
  launcher = launcher.replace(/const BUN_SHA = '[a-f0-9]+';/u, `const BUN_SHA = '${sha(await readFile(process.execPath))}';`);
  installer = installer.replace(/readonly BUN_ARCHIVE_SHA='[a-f0-9]+'/u, `readonly BUN_ARCHIVE_SHA='${sha(await readFile(zip))}'`)
    .replace(/readonly BUN_SHA='[a-f0-9]+'/u, `readonly BUN_SHA='${sha(await readFile(process.execPath))}'`);
}
await writeFile(launcherPath, launcher);
const installerPath = join(fixtureDir, 'install.sh'); await writeFile(installerPath, installer);
const environment = { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: linux ? '/bin/bash' : '/bin/zsh', VIRGO_TEST_FILES: fixtureDir, VIRGO_TEST_GITHUB: github,
  VIRGO_TEST_LAUNCHER: launcherPath, VIRGO_TEST_DISPATCH: dispatchLog, VIRGO_TEST_DOWNLOAD_LOG: downloadLog, VIRGO_TEST_BUN_PACKAGE: bunPackage, VIRGO_TEST_CLI_ASSET: cliAsset };
// A fixture CLI decodes the selected Host's provider replacement receipts up to
// its own schema, exactly where the product's preflight refuses.
const cli = (marker, schema) => `#!/unusable/interpreter
import{readFile,readdir}from'node:fs/promises';import{join}from'node:path';import{homedir}from'node:os';
if(process.env.VIRGO_TEST_EXPECT_EXECUTABLE&&await import('node:fs/promises').then(m=>m.realpath(process.execPath))!==process.env.VIRGO_TEST_EXPECT_EXECUTABLE){console.error('supervisor interpreter mismatch');process.exit(88);}
const args=process.argv.slice(2),marker=${JSON.stringify(marker)};await Bun.write(process.env.VIRGO_TEST_DISPATCH,JSON.stringify({marker,args}));
const flag=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const receipts=join(flag('--root')??join(homedir(),'virgo'),'instances',encodeURIComponent(flag('--machine')+'\\0agent_host\\0'+(flag('--instance')??'host')),'.provider-replacements');
let count=0;
try{for(const name of await readdir(receipts)){let journal=null;try{journal=JSON.parse(await readFile(join(receipts,name),'utf8'));}catch{}
 if(!journal||typeof journal.schemaVersion!=='number'||journal.schemaVersion>${schema}){console.error(marker+': Provider replacement receipts could not be inspected.');process.exit(2);}count++;}}
catch(error){if(error.code!=='ENOENT')throw error;}
console.log(JSON.stringify({ok:true,marker,receipts:count}));process.exit(0);
`;
const oldCli = Buffer.from(cli('old', 1)), targetCli = Buffer.from(cli('target', 2));
await writeFile(assetPath, oldCli);
// Channel metadata selects by platform; a foreign-platform decoy must not be chosen.
const pin = { version: '2.0.1', platform, release: older, cliSha256: sha(oldCli), operator: { release: older, cliSha256: sha(oldCli) } };
await writeFile(join(fixtureDir, 'current.json'), JSON.stringify({ sourceRepository: 'virgo-codes/virgo', launcherSha256: sha(Buffer.from(launcher)),
  platforms: [{ ...pin, platform: foreign, release: 'b'.repeat(64) }, pin] }));
const downloader = join(root, 'download.js');
await writeFile(downloader, `import{readFile,writeFile,appendFile,lstat}from'node:fs/promises';import{join}from'node:path';
const args=process.argv.slice(2),url=args.at(-3),out=args.at(-1),env=process.env;await appendFile(env.VIRGO_TEST_DOWNLOAD_LOG,JSON.stringify(args)+'\\n');
if(args.at(-2)!=='--output'||!url.startsWith('https://'))process.exit(93);
if(env.VIRGO_TEST_FAIL&&url.includes(env.VIRGO_TEST_FAIL))process.exit(23);
const asset=/^https:\\/\\/github\\.com\\/([A-Za-z0-9._-]+)\\/([A-Za-z0-9._-]+)\\/releases\\/download\\/(release-[a-f0-9]{64})\\/([A-Za-z0-9._-]+)$/u.exec(url);
let source=asset&&await lstat(join(env.VIRGO_TEST_GITHUB,...asset.slice(1))).then(()=>join(env.VIRGO_TEST_GITHUB,...asset.slice(1)),()=>null);
source??=url.endsWith('/current.json')?join(env.VIRGO_TEST_FILES,'current.json'):url.endsWith('/launcher.js')?env.VIRGO_TEST_LAUNCHER:url.endsWith('/'+env.VIRGO_TEST_BUN_PACKAGE+'.zip')?join(env.VIRGO_TEST_FILES,'bun.zip'):url.endsWith('/'+env.VIRGO_TEST_CLI_ASSET)?join(env.VIRGO_TEST_FILES,'current cli'):null;
if(!source)process.exit(94);await writeFile(out,await readFile(source));`);
await writeFile(join(bin, 'curl'), `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(downloader)} "$@"\n`, { mode: 0o700 });
await writeFile(join(bin, 'gh'), '#!/bin/bash\nexit 91\n', { mode: 0o700 });

let cases = 0;
const command = (executable, args, env) => { const result = spawnSync(executable, args, { env, encoding: 'utf8' }); if (result.error) throw result.error; return result; };
const success = result => { if (result.status !== 0) throw new Error(JSON.stringify(result)); cases++; return result; };
const rejected = (result, contains) => { if (result.status === 0 || (contains && !result.stderr.includes(contains))) throw new Error(JSON.stringify(result)); cases++; return result; };
const absent = async (path, message) => { try { await lstat(path); throw new Error(message); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
async function dispatch(marker, args) {
  const actual = JSON.parse(await readFile(dispatchLog, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify({ marker, args })) throw new Error(JSON.stringify({ actual, marker, args }));
}
const downloads = async () => (await readFile(downloadLog, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).at(-3));
// Byte-identical to virgo distribution/local-distribution.ts:15-26 (canonical,
// computeManifestDigest): localeCompare key order, version excluded, compatibility
// bound only when present. The manifest is hashed as its canonical UTF-8 string.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
const manifestDigest = ({ release, artifacts, compatibility }) => sha(canonical({ release, artifacts, ...(compatibility === undefined ? {} : { compatibility }) }));
function archive(release, cliBytes, descriptorRelease = release, archivePlatform = platform) {
  const descriptor = Buffer.from(JSON.stringify({ release: descriptorRelease, adapterDirectory: 'adapters', daemonSupervision: { protocolVersion: 1, cliExecutable: 'bin/virgo' } }) + '\n');
  return Buffer.from(JSON.stringify({ schemaVersion: 1, component: 'agent_host', release, platform: archivePlatform,
    entries: [['bin/virgo', cliBytes], ['release.json', descriptor]].map(([path, bytes]) => ({ path, kind: 'file', mode: 0o755, digest: sha(bytes), content: bytes.toString('base64') })) }) + '\n');
}
/**
 * Publish R as every supported distribution, with virgo's real names: the
 * manifest `<R>.json` and archive `<R>.vra` (single platform) or
 * `<R>-<os>-<arch>.vra` (pinned platform builds) from distribution/build-release.ts:184,193,
 * read under tag `release-<R>` exactly as distribution/github-release.ts:150-161,195.
 */
async function publish(name, options = {}) {
  const { archiveBytes = archive(target, targetCli), pinnedArchive = archiveBytes, bootstrap = targetCli, compatibility,
    assetName = `${target}-${platform.os}-${platform.architecture}.vra`, release = target, digestOverride, sourceUrl, artifactPlatform = platform } = options;
  const manifests = join(root, `${name} manifests`), bundle = join(root, `${name} bundle`);
  const tags = [OFFICIAL, UNOFFICIAL].map(repo => join(github, ...repo.split('/'), `release-${target}`));
  for (const path of [manifests, bundle, ...tags]) { await rm(path, { recursive: true, force: true }); await mkdir(path, { recursive: true, mode: 0o700 }); }
  const manifest = source => {
    const artifacts = [{ component: 'agent_host', release, platform: artifactPlatform, format: 'native_archive', digest: sha(pinnedArchive), source }];
    const unsigned = { release, artifacts, ...(compatibility === undefined ? {} : { compatibility }) };
    return Buffer.from(JSON.stringify({ ...unsigned, version: '2.2.8', manifestDigest: digestOverride ?? manifestDigest(unsigned) }, null, 2) + '\n');
  };
  await writeFile(join(manifests, assetName), archiveBytes);
  await writeFile(join(manifests, `${target}.json`), manifest({ kind: 'local', path: join(manifests, assetName) }));
  const preview = manifest({ kind: 'local', path: join(bundle, assetName) });
  await writeFile(join(bundle, assetName), archiveBytes); await writeFile(join(bundle, `${target}.json`), preview); await writeFile(join(bundle, 'virgo'), bootstrap, { mode: 0o755 });
  await writeFile(join(bundle, 'SHA256SUMS'), [[`${target}.json`, preview], [assetName, archiveBytes], ['virgo', bootstrap]].map(([file, bytes]) => `${sha(bytes)}  ${file}`).join('\n') + '\n');
  for (const [index, repo] of [OFFICIAL, UNOFFICIAL].entries()) {
    await writeFile(join(tags[index], assetName), archiveBytes);
    await writeFile(join(tags[index], `${target}.json`), manifest({ kind: 'https', url: sourceUrl ?? `https://github.com/${repo}/releases/download/release-${target}/${assetName}` }));
  }
  return [['--manifest-directory', manifests], ['--bundle', bundle], ['--github-repository', OFFICIAL]];
}
async function installedFixture(home, installationRoot, release, cliBytes) {
  const machine = 'isolated', instance = 'host', targetIdentity = { machine, component: 'agent_host', instance };
  const directory = join(installationRoot, 'instances', encodeURIComponent(`${machine}\0agent_host\0${instance}`));
  const archiveBytes = archive(release, cliBytes), digest = sha(archiveBytes), descriptor = JSON.parse(archiveBytes).entries[1];
  const releaseDirectory = join(installationRoot, 'releases', `${release}-${digest}`), handle = join(installationRoot, 'cache', digest);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(join(releaseDirectory, 'bin'), { recursive: true }); await mkdir(dirname(handle), { recursive: true });
  await writeFile(join(releaseDirectory, 'bin', 'virgo'), cliBytes, { mode: 0o555 });
  await writeFile(join(releaseDirectory, 'release.json'), Buffer.from(descriptor.content, 'base64'), { mode: 0o444 });
  await writeFile(handle, archiveBytes, { mode: 0o600 });
  await writeFile(join(directory, 'virgo.config.json'), JSON.stringify({ schemaVersion: 1, machine, release, mode: 'host' }), { mode: 0o600 });
  await writeFile(join(directory, 'installation-state.json'), JSON.stringify({ schemaVersion: 1, target: targetIdentity, installedRelease: release,
    active: { releaseDirectory, artifact: { handle, artifact: { component: 'agent_host', release, platform, format: 'native_archive', digest } } } }), { mode: 0o600 });
  const executable = join(home, '.local/share/virgo/bootstrap/bun/1.3.14/bin/bun'), info = await lstat(executable);
  const registration = join(installationRoot, 'processes', 'supervision', 'registration');
  await mkdir(registration, { recursive: true, mode: 0o700 });
  const receiptPath = join(registration, 'supervisor.json');
  await writeFile(receiptPath, JSON.stringify({ schemaVersion: 1, root: installationRoot, releaseDirectory, cli: join(releaseDirectory, 'bin', 'virgo'), cliDigest: sha(cliBytes),
    executable, executableIdentity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
    launchAgentsDirectory: linux ? join(home, '.config', 'systemd', 'user') : join(home, 'Library', 'LaunchAgents'), intervalSeconds: 5 }), { mode: 0o600 });
  // A later release's prepared provider replacement receipt the 2.2.1-class CLI cannot decode.
  const receipts = join(directory, '.provider-replacements'); await mkdir(receipts, { mode: 0o700 });
  const journal = join(receipts, `${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}.json`);
  await writeFile(journal, JSON.stringify({ schemaVersion: 2, operationId: 'later-release', phase: 'prepared' }), { mode: 0o600 });
  return { directory, executable, receiptPath, journal };
}

try {
  const home = join(root, 'pumori class home'); await mkdir(home);
  const env = { ...environment, HOME: home }, virgo = join(home, '.local', 'bin', 'virgo'), state = join(home, '.local/share/virgo/launcher');
  success(command('/bin/bash', [installerPath], env));
  const installationRoot = join(root, 'old installed root');
  const installed = await installedFixture(home, installationRoot, older, oldCli);
  const pinned = { ...env, VIRGO_TEST_EXPECT_EXECUTABLE: installed.executable };
  const evidence = async () => Buffer.concat(await Promise.all([installed.journal, join(installed.directory, 'installation-state.json'), join(installed.directory, 'virgo.config.json'), installed.receiptPath].map(path => readFile(path))));
  const before = await evidence();
  const upgrade = (distribution, extra = [], at = installationRoot) => ['upgrade', '--mode', 'host', '--machine', 'isolated', '--root', at, '--release', target, ...distribution, ...extra];
  const oldRefusal = 'old: Provider replacement receipts could not be inspected.';

  // The target's own checks govern the old installed Host through every
  // distribution and both published archive names; the request reaches it
  // byte-for-byte, independent from channel metadata and its 2.2.1-class operator.
  for (const published of [{}, { assetName: `${target}.vra` }, { compatibility: { schemaVersion: 1, minimumInstalledVersion: '2.2.1' } }]) {
    for (const distribution of await publish('verified', published)) {
      for (const extra of [['--preflight-only', 'true'], [], ['--activate', 'false']]) {
        const args = upgrade(distribution, extra);
        await rm(dispatchLog, { force: true }); await rm(downloadLog, { force: true });
        const result = success(command(virgo, args, { ...pinned, VIRGO_TEST_FAIL: 'current.json' }));
        await dispatch('target', args);
        if (result.stderr.includes('could not be inspected') || JSON.parse(result.stdout).receipts !== 1) throw new Error(JSON.stringify(result));
        if ((await downloads()).some(url => url.endsWith('/current.json') || url.endsWith(`/${cliAsset}`))) throw new Error('Target dispatch consulted the independent current operator.');
        if (!before.equals(await evidence())) throw new Error('Target dispatch changed receipts or installation state.');
      }
    }
  }
  // An absent installation target keeps the clean-install path: the configured
  // runtime runs the target CLI, and the launcher creates no installation.
  const freshRoot = join(root, 'absent target root');
  for (const distribution of await publish('verified')) {
    const args = upgrade(distribution, [], freshRoot);
    await rm(dispatchLog, { force: true });
    success(command(virgo, args, pinned)); await dispatch('target', args);
    await absent(freshRoot, 'Launcher created the absent installation target.');
  }

  // Inverse: the target's own receipt check refuses a broken receipt, and that
  // refusal is final; the launcher never retries through the older operator.
  const intact = await readFile(installed.journal);
  await writeFile(installed.journal, '{"schemaVersion":', { mode: 0o600 });
  for (const distribution of await publish('verified')) {
    const args = upgrade(distribution);
    await rm(dispatchLog, { force: true });
    rejected(command(virgo, args, pinned), 'target: Provider replacement receipts could not be inspected.');
    await dispatch('target', args);
  }
  if ((await readFile(installed.journal, 'utf8')) !== '{"schemaVersion":') throw new Error('Target refusal changed the broken receipt.');
  await writeFile(installed.journal, intact, { mode: 0o600 });

  // A wrong, foreign or unverifiable target is never cached or run; the launcher
  // logs and keeps the current behaviour: the official operator, exact request.
  const tamperedCli = Buffer.from(cli('tampered', 2)), good = archive(target, targetCli);
  const entries = JSON.parse(good).entries.map(entry => entry.path === 'bin/virgo' ? { ...entry, content: tamperedCli.toString('base64') } : entry);
  const outside = `https://github.com/${UNOFFICIAL}/releases/download/release-${target}/${target}-${platform.os}-${platform.architecture}.vra`;
  const fallThrough = async (reason, distribution, unavailable = pinned) => {
    const args = upgrade(distribution), cached = await readdir(join(state, 'releases'));
    await rm(dispatchLog, { force: true }); await rm(downloadLog, { force: true });
    const result = rejected(command(virgo, args, unavailable), oldRefusal);
    await dispatch('old', args);
    if (!result.stderr.includes('could not be authenticated')) throw new Error(`Unverified target (${reason}) was not logged: ${result.stderr}`);
    if (JSON.stringify(await readdir(join(state, 'releases'))) !== JSON.stringify(cached)) throw new Error(`Unverified target (${reason}) was cached.`);
    if (!before.equals(await evidence())) throw new Error(`Unverified target (${reason}) changed receipts or installation state.`);
    return downloads();
  };
  for (const [reason, published, only] of [
    // The real archive is present at every source; only its bytes differ from the pinned digest.
    ['archive digest differs from its manifest', { archiveBytes: Buffer.concat([good, Buffer.from(' ')]), pinnedArchive: good }],
    ['manifest digest is wrong', { digestOverride: '0'.repeat(64) }],
    ['manifest names another release', { release: older }],
    ['artifact is for another platform', { artifactPlatform: foreign }],
    ['archive CLI entry differs from its digest', { archiveBytes: Buffer.from(JSON.stringify({ ...JSON.parse(good), entries }) + '\n') }],
    ['archive names another release', { archiveBytes: archive(older, targetCli) }],
    ['archive is for another platform', { archiveBytes: archive(target, targetCli, target, foreign) }],
    ['descriptor names another release', { archiveBytes: archive(target, targetCli, older) }],
    // A manifest directory's local source path is not name-bound by the product
    // (local-distribution.ts:73-74); bundle and GitHub names are.
    ['archive name is not a published name', { assetName: 'virgo-host.vra' }, ['--bundle', '--github-repository']],
    ['bundle bootstrap differs from the archive CLI', { bootstrap: tamperedCli }, ['--bundle']],
    ['GitHub manifest points outside the official release tag', { sourceUrl: outside }, ['--github-repository']],
  ]) {
    for (const distribution of (await publish('wrong', published)).filter(([flag]) => !only || only.includes(flag))) await fallThrough(reason, distribution);
  }
  // Only the official repository is trusted for GitHub; another repository's
  // verified-looking release is never fetched or run.
  await publish('verified');
  const unofficial = await fallThrough('non-official GitHub repository', ['--github-repository', UNOFFICIAL]);
  if (unofficial.some(url => url.includes(`/${UNOFFICIAL}/`))) throw new Error('Launcher fetched from a non-official repository.');
  // Absent distribution directories and unavailable assets keep the current behaviour too.
  await fallThrough('absent manifest directory', ['--manifest-directory', join(root, 'absent manifests')]);
  await fallThrough('absent bundle directory', ['--bundle', join(root, 'absent bundle')]);
  await fallThrough('unavailable GitHub release', ['--github-repository', OFFICIAL], { ...pinned, VIRGO_TEST_FAIL: `/release-${target}/` });

  // Runtime/installation guards still run before target selection: a pending
  // interpreter migration or changed supervisor receipt never reaches the target.
  const verified = await publish('verified');
  const transition = join(dirname(installed.receiptPath), 'runtime-transition.json');
  await writeFile(transition, JSON.stringify({ planId: 'd'.repeat(64) }), { mode: 0o600 });
  for (const distribution of verified) {
    await rm(dispatchLog, { force: true }); await rm(downloadLog, { force: true });
    rejected(command(virgo, upgrade(distribution), pinned), 'migration is pending');
    await absent(dispatchLog, 'Pending migration reached the target CLI.');
    if ((await downloads()).length) throw new Error('Pending migration downloaded the target.');
  }
  await rm(transition);
  const receipt = await readFile(installed.receiptPath);
  await writeFile(installed.receiptPath, JSON.stringify({ ...JSON.parse(receipt), cliDigest: '0'.repeat(64) }), { mode: 0o600 });
  for (const distribution of verified) {
    await rm(dispatchLog, { force: true });
    rejected(command(virgo, upgrade(distribution), pinned), 'Supervisor CLI differs'); await absent(dispatchLog, 'Changed supervisor receipt reached the target CLI.');
  }
  await writeFile(installed.receiptPath, receipt, { mode: 0o600 });

  // Without an explicit release the official current operator remains the selection.
  const implicit = ['upgrade', '--mode', 'host', '--machine', 'isolated', '--root', installationRoot];
  await rm(dispatchLog, { force: true });
  rejected(command(virgo, implicit, pinned), oldRefusal);
  await dispatch('old', [...implicit, '--release', older, '--github-repository', OFFICIAL]);
  if (!before.equals(await evidence())) throw new Error('Upgrade dispatch changed receipts or installation state.');
  console.log(`PASS: ${cases} explicit-target upgrade dispatch checks on ${platform.os} ${platform.architecture}; real launcher/Bun, 2.2.1-class installed Host and operator, isolated fixtures, no live Hub/Host/provider effects.`);
} finally { await rm(root, { recursive: true, force: true }); }
