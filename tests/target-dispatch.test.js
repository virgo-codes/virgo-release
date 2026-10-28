import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, readdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// S289 (frozen spec 512c1f5a): only `upgrade --release R --github-repository
// virgo-codes/virgo-release` runs R's own CLI, verified as virgo's GitHub
// distribution verifies it. The installed release and the independent
// current.operator stay pinned to a 2.2.1-class CLI which cannot decode a
// receipt written by a later release, so only R's own checks can govern.
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
const tag = `release-${target}`, metadataUrl = `https://api.github.com/repos/${OFFICIAL}/releases/tags/${tag}`;
const MANIFEST_ID = 101, ARCHIVE_ID = 202;
// The launcher's fixed bound on integrity re-fetches within one command.
const INTEGRITY_ATTEMPTS = 3;
const fixtureDir = join(root, 'official files'), github = join(root, 'github api'), bin = join(root, 'fixture bin');
await mkdir(fixtureDir, { recursive: true }); await mkdir(github); await mkdir(bin);
const launcherPath = join(fixtureDir, 'launcher.js'), assetPath = join(fixtureDir, 'current cli'), zip = join(fixtureDir, 'bun.zip');
const dispatchLog = join(root, 'dispatch.jsonl'), downloadLog = join(root, 'download.jsonl');
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
// A fixture CLI appends every execution to the dispatch log, then decodes the
// selected Host's provider replacement receipts up to its own schema, exactly
// where the product's preflight refuses.
const cli = (marker, schema) => `#!/unusable/interpreter
import{readFile,readdir,appendFile}from'node:fs/promises';import{join}from'node:path';import{homedir}from'node:os';
if(process.env.VIRGO_TEST_EXPECT_EXECUTABLE&&await import('node:fs/promises').then(m=>m.realpath(process.execPath))!==process.env.VIRGO_TEST_EXPECT_EXECUTABLE){console.error('supervisor interpreter mismatch');process.exit(88);}
const args=process.argv.slice(2),marker=${JSON.stringify(marker)};await appendFile(process.env.VIRGO_TEST_DISPATCH,JSON.stringify({marker,args})+'\\n');
const flag=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const receipts=join(flag('--root')??join(homedir(),'virgo'),'instances',encodeURIComponent(flag('--machine')+'\\0agent_host\\0'+(flag('--instance')??'host')),'.provider-replacements');
let count=0;
try{for(const name of await readdir(receipts)){let journal=null;try{journal=JSON.parse(await readFile(join(receipts,name),'utf8'));}catch{}
 if(!journal||typeof journal.schemaVersion!=='number'||journal.schemaVersion>${schema}){console.error(marker+': Provider replacement receipts could not be inspected.');process.exit(2);}count++;}}
catch(error){if(error.code!=='ENOENT')throw error;}
console.log(JSON.stringify({ok:true,marker,receipts:count}));process.exit(0);
`;
const oldCli = Buffer.from(cli('old', 1)), targetCli = Buffer.from(cli('target', 2)), tamperedCli = Buffer.from(cli('tampered', 2));
await writeFile(assetPath, oldCli);
// Channel metadata selects by platform; a foreign-platform decoy must not be chosen.
const pin = { version: '2.0.1', platform, release: older, cliSha256: sha(oldCli), operator: { release: older, cliSha256: sha(oldCli) } };
await writeFile(join(fixtureDir, 'current.json'), JSON.stringify({ sourceRepository: 'virgo-codes/virgo', launcherSha256: sha(Buffer.from(launcher)),
  platforms: [{ ...pin, platform: foreign, release: 'b'.repeat(64) }, pin] }));
// The fixture GitHub API serves <repo>/tags/<tag>.json for releases/tags/<tag>
// and <repo>/assets/<id> for releases/assets/<id>, each only under its exact
// Accept header (github-release.ts:182,189). A `.first` variant is served once.
const downloader = join(root, 'download.js');
await writeFile(downloader, `import{readFile,writeFile,appendFile,lstat,rm}from'node:fs/promises';import{join}from'node:path';
const args=process.argv.slice(2),url=args.at(-3),out=args.at(-1),env=process.env;await appendFile(env.VIRGO_TEST_DOWNLOAD_LOG,JSON.stringify(args)+'\\n');
if(args.at(-2)!=='--output'||!url.startsWith('https://'))process.exit(93);
if(env.VIRGO_TEST_FAIL&&url.includes(env.VIRGO_TEST_FAIL))process.exit(23);
const exists=path=>lstat(path).then(()=>true,()=>false);
const header=name=>{const values=[];for(let i=0;i<args.length;i++)if(args[i]==='--header'&&args[i+1]?.toLowerCase().startsWith(name+':'))values.push(args[i+1].slice(name.length+1).trim());return values;};
const api=/^https:\\/\\/api\\.github\\.com\\/repos\\/([A-Za-z0-9._-]+)\\/([A-Za-z0-9._-]+)\\/releases\\/(tags|assets)\\/([A-Za-z0-9._-]+)$/u.exec(url);
let source=null;
if(api){
 const accept=api[3]==='tags'?'application/vnd.github+json':'application/octet-stream';
 if(JSON.stringify(header('accept'))!==JSON.stringify([accept]))process.exit(95);
 const path=join(env.VIRGO_TEST_GITHUB,api[1],api[2],api[3],api[3]==='tags'?api[4]+'.json':api[4]);
 if(await exists(path+'.first')){await writeFile(out,await readFile(path+'.first'));await rm(path+'.first');process.exit(0);}
 if(!await exists(path))process.exit(22);
 source=path;
}
source??=url.endsWith('/current.json')?join(env.VIRGO_TEST_FILES,'current.json'):url.endsWith('/launcher.js')?env.VIRGO_TEST_LAUNCHER:url.endsWith('/'+env.VIRGO_TEST_BUN_PACKAGE+'.zip')?join(env.VIRGO_TEST_FILES,'bun.zip'):url.endsWith('/'+env.VIRGO_TEST_CLI_ASSET)?join(env.VIRGO_TEST_FILES,'current cli'):null;
if(!source)process.exit(94);await writeFile(out,await readFile(source));`);
await writeFile(join(bin, 'curl'), `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(downloader)} "$@"\n`, { mode: 0o700 });
await writeFile(join(bin, 'gh'), '#!/bin/bash\nexit 91\n', { mode: 0o700 });

let cases = 0;
const command = (executable, args, env) => { const result = spawnSync(executable, args, { env, encoding: 'utf8' }); if (result.error) throw result.error; return result; };
const success = result => { if (result.status !== 0) throw new Error(JSON.stringify(result)); cases++; return result; };
const rejected = (result, contains) => { if (result.status === 0 || (contains && !result.stderr.includes(contains))) throw new Error(JSON.stringify(result)); cases++; return result; };
const absent = async (path, message) => { try { await lstat(path); throw new Error(message); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
const dispatched = async () => (await readFile(dispatchLog, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
// Exactly one CLI ran, with exactly these arguments.
async function dispatch(marker, args) {
  const actual = await dispatched();
  if (JSON.stringify(actual) !== JSON.stringify([{ marker, args }])) throw new Error(JSON.stringify({ actual, marker, args }));
}
const downloads = async () => (await readFile(downloadLog, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).at(-3));
const operatorDownloads = urls => urls.filter(url => url.endsWith('/current.json') || url.endsWith(`/${cliAsset}`));
const apiDownloads = urls => urls.filter(url => url.startsWith('https://api.github.com/'));
// Byte-identical to virgo distribution/local-distribution.ts:15-26 (canonical,
// computeManifestDigest): localeCompare key order, version excluded, compatibility
// bound only when present.
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
const good = archive(target, targetCli);
const browserUrl = (repo, name) => `https://github.com/${repo}/releases/download/${tag}/${name}`;
/**
 * Publish R under tag `release-<R>` for both repositories with virgo's real
 * names (build-release.ts:184; github-release.ts:159,195): the manifest
 * `<R>.json` and archive `<R>.vra` or `<R>-<os>-<arch>.vra`, whose https source
 * is that repository's browser asset URL. Options mutate exactly one fact.
 */
async function publish(options = {}) {
  const { archiveBytes = good, pinnedArchive = archiveBytes, compatibility, assetName = `${target}-${platform.os}-${platform.architecture}.vra`, release = target,
    digestOverride, sourceUrl, artifactPlatform = platform, extraArtifact = false, manifestBytes, firstArchive, firstManifest, omit = [], duplicate, tagName = tag } = options;
  for (const repo of [OFFICIAL, UNOFFICIAL]) {
    const at = join(github, ...repo.split('/'));
    await rm(at, { recursive: true, force: true }); await mkdir(join(at, 'tags'), { recursive: true }); await mkdir(join(at, 'assets'));
    const artifact = { component: 'agent_host', release, platform: artifactPlatform, format: 'native_archive', digest: sha(pinnedArchive), source: { kind: 'https', url: sourceUrl ?? browserUrl(repo, assetName) } };
    const artifacts = extraArtifact ? [artifact, { ...artifact, digest: sha(Buffer.from('second')) }] : [artifact];
    const unsigned = { release, artifacts, ...(compatibility === undefined ? {} : { compatibility }) };
    const manifest = manifestBytes ?? Buffer.from(JSON.stringify({ ...unsigned, version: '2.2.8', manifestDigest: digestOverride ?? manifestDigest(unsigned) }, null, 2) + '\n');
    const assets = [{ id: MANIFEST_ID, name: `${target}.json`, size: manifest.length }, { id: ARCHIVE_ID, name: assetName, size: archiveBytes.length }]
      .filter(asset => !omit.includes(asset.id));
    if (duplicate) assets.push({ ...assets.find(asset => asset.id === duplicate), id: 303 });
    await writeFile(join(at, 'tags', `${tag}.json`), JSON.stringify({ tag_name: tagName, draft: false, assets }));
    await writeFile(join(at, 'assets', String(MANIFEST_ID)), manifest);
    await writeFile(join(at, 'assets', String(ARCHIVE_ID)), archiveBytes);
    if (firstManifest) await writeFile(join(at, 'assets', `${MANIFEST_ID}.first`), firstManifest);
    if (firstArchive) await writeFile(join(at, 'assets', `${ARCHIVE_ID}.first`), firstArchive);
  }
}
// A local manifest directory and bundle for R, whose bundled CLI would succeed if run.
async function localPublication() {
  const manifests = join(root, 'local manifests'), bundle = join(root, 'local bundle'), name = `${target}.vra`, bundled = Buffer.from(cli('bundle', 2));
  for (const path of [manifests, bundle]) { await rm(path, { recursive: true, force: true }); await mkdir(path, { recursive: true, mode: 0o700 }); }
  for (const at of [manifests, bundle]) {
    const unsigned = { release: target, artifacts: [{ component: 'agent_host', release: target, platform, format: 'native_archive', digest: sha(good), source: { kind: 'local', path: join(at, name) } }] };
    await writeFile(join(at, name), good); await writeFile(join(at, `${target}.json`), JSON.stringify({ ...unsigned, version: '2.2.8', manifestDigest: manifestDigest(unsigned) }));
  }
  await writeFile(join(bundle, 'virgo'), bundled, { mode: 0o755 });
  return [['--manifest-directory', manifests], ['--bundle', bundle]];
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
  const cachedCli = join(state, 'releases', sha(targetCli), 'virgo');
  const upgrade = (distribution, extra = [], at = installationRoot) => ['upgrade', '--mode', 'host', '--machine', 'isolated', '--root', at, '--release', target, ...distribution, ...extra];
  const official = ['--github-repository', OFFICIAL];
  const oldRefusal = 'old: Provider replacement receipts could not be inspected.';
  const reset = async () => { await rm(dispatchLog, { force: true }); await rm(downloadLog, { force: true }); };
  const unchanged = async reason => { if (!before.equals(await evidence())) throw new Error(`${reason}: receipts, state, config or supervisor bytes changed.`); };

  // Point 4 (fails on base): the old 2.2.1-class installed Host, through the real
  // installed wrapper, reaches R's CLI with R's checks governing; the request is
  // forwarded byte-for-byte (point 6) and current.operator is never consulted.
  for (const published of [{}, { assetName: `${target}.vra` }, { compatibility: { schemaVersion: 1, minimumInstalledVersion: '2.2.1' } }]) {
    await publish(published);
    for (const extra of [['--preflight-only', 'true'], [], ['--activate', 'false']]) {
      const args = upgrade(official, extra);
      await rm(join(state, 'releases', sha(targetCli)), { recursive: true, force: true }); await reset();
      const result = success(command(virgo, args, { ...pinned, VIRGO_TEST_FAIL: 'current.json' }));
      await dispatch('target', args);
      if (result.stderr.includes('could not be inspected') || JSON.parse(result.stdout).receipts !== 1) throw new Error(JSON.stringify(result));
      const urls = await downloads();
      if (operatorDownloads(urls).length) throw new Error('Target dispatch consulted the independent current operator.');
      if (JSON.stringify(apiDownloads(urls)) !== JSON.stringify([metadataUrl, `https://api.github.com/repos/${OFFICIAL}/releases/assets/${MANIFEST_ID}`, `https://api.github.com/repos/${OFFICIAL}/releases/assets/${ARCHIVE_ID}`]))
        throw new Error(`Target was not fetched as the GitHub verifier fetches it: ${JSON.stringify(urls)}`);
      // Point 6: cached under stateRoot/releases/<cliSha>/virgo with R's exact CLI bytes.
      if (!targetCli.equals(await readFile(cachedCli))) throw new Error('Verified target CLI was not cached by its digest.');
      await unchanged('Target dispatch');
    }
  }
  // An absent installation target keeps the clean-install path: the configured
  // runtime runs R's CLI, and the launcher creates no installation.
  const freshRoot = join(root, 'absent target root');
  await publish(); await reset();
  success(command(virgo, upgrade(official, [], freshRoot), pinned)); await dispatch('target', upgrade(official, [], freshRoot));
  await absent(freshRoot, 'Launcher created the absent installation target.');

  // Point 4 inverse: R's own receipt check refuses a broken receipt, and that
  // refusal is final; the launcher never retries through the older operator.
  const intact = await readFile(installed.journal);
  await writeFile(installed.journal, '{"schemaVersion":', { mode: 0o600 });
  await reset();
  const refusal = command(virgo, upgrade(official), pinned);
  rejected(refusal, 'target: Provider replacement receipts could not be inspected.');
  if (refusal.status !== 2) throw new Error('Target CLI exit status was not forwarded.');
  await dispatch('target', upgrade(official));
  if (operatorDownloads(await downloads()).length) throw new Error('Target refusal was retried through the operator.');
  if ((await readFile(installed.journal, 'utf8')) !== '{"schemaVersion":') throw new Error('Target refusal changed the broken receipt.');
  await writeFile(installed.journal, intact, { mode: 0o600 });

  // Point 2: --manifest-directory and --bundle keep today's exact behaviour: the
  // official operator runs with the request unchanged; no local bin is executed,
  // nothing is fetched from GitHub and no target outcome is reported.
  for (const distribution of await localPublication()) {
    const args = upgrade(distribution); await reset();
    const result = rejected(command(virgo, args, pinned), oldRefusal);
    await dispatch('old', args);
    if (apiDownloads(await downloads()).length || /target unavailable|integrity/u.test(result.stderr)) throw new Error(`Local distribution took the target dispatch: ${result.stderr}`);
  }
  // Point 1: another repository keeps today's path and is never fetched.
  await publish(); await reset();
  {
    const args = upgrade(['--github-repository', UNOFFICIAL]);
    const result = rejected(command(virgo, args, pinned), oldRefusal);
    await dispatch('old', args);
    if (apiDownloads(await downloads()).length || /target unavailable|integrity/u.test(result.stderr)) throw new Error('Non-official repository took the target dispatch.');
  }

  // Point 3(a)/7: fetch-class failures log "target unavailable" with the cause and
  // fall through once, with no retry, to today's operator with the request unchanged.
  // Each asserts the fetch outcome only; none can satisfy an integrity case.
  const fetchClass = async (cause, published, extraEnv = {}) => {
    await publish(published); await reset();
    const args = upgrade(official);
    await rm(join(state, 'releases', sha(targetCli)), { recursive: true, force: true });
    const before = await readdir(join(state, 'releases'));
    const result = rejected(command(virgo, args, { ...pinned, ...extraEnv }), oldRefusal);
    await dispatch('old', args);
    if (!result.stderr.includes('target unavailable') || !result.stderr.includes(cause)) throw new Error(`Fetch failure (${cause}) was not reported: ${result.stderr}`);
    if (/integrity/u.test(result.stderr) || result.status === 75) throw new Error(`Fetch failure (${cause}) was reported as integrity: ${result.stderr}`);
    if ((await downloads()).filter(url => url === metadataUrl).length !== 1) throw new Error(`Fetch failure (${cause}) was retried.`);
    if (JSON.stringify(await readdir(join(state, 'releases'))) !== JSON.stringify(before)) throw new Error(`Unavailable target (${cause}) was cached.`);
    await unchanged(`Unavailable target (${cause})`);
  };
  await fetchClass('GitHub Release metadata is unavailable.', {}, { VIRGO_TEST_FAIL: `/releases/tags/${tag}` });
  await fetchClass(`GitHub Release is missing required asset ${target}.json.`, { omit: [MANIFEST_ID] });
  await fetchClass(`GitHub Release is missing required asset ${target}-${platform.os}-${platform.architecture}.vra.`, { omit: [ARCHIVE_ID] });
  await fetchClass('GitHub Release asset is unavailable.', {}, { VIRGO_TEST_FAIL: `/releases/assets/${ARCHIVE_ID}` });
  await fetchClass('GitHub Release has no artifact for this platform.', { artifactPlatform: foreign });

  // Point 3(b) RULED/7: integrity-class failures never execute anything: the bad
  // artifact is discarded (not cached), re-fetched with bounded backoff, the
  // installed verified release is left working and untouched, no operator upgrade
  // runs, and the result states the installed version is kept with the failed check, never "refused".
  const integrityClass = async (cause, published) => {
    await publish(published); await reset();
    await rm(join(state, 'releases', sha(targetCli)), { recursive: true, force: true });
    const before = await readdir(join(state, 'releases'));
    const result = command(virgo, upgrade(official), pinned);
    const kept = `installed version kept, still working; integrity failed: ${cause.replace(/\.$/u, '')}; the next upgrade run will retry`;
    if (result.status !== 75 || !result.stderr.split('\n').includes(`virgo: ${kept}`)) throw new Error(`Integrity failure (${cause}) was not reported: ${JSON.stringify(result)}`);
    if (/refused|target unavailable/u.test(result.stderr)) throw new Error(`Integrity failure (${cause}) was reported as a refusal or fetch failure: ${result.stderr}`);
    cases++;
    if ((await dispatched()).length) throw new Error(`Integrity failure (${cause}) executed a CLI: ${JSON.stringify(await dispatched())}`);
    const urls = await downloads();
    if (operatorDownloads(urls).length) throw new Error(`Integrity failure (${cause}) fell through to the operator.`);
    if (urls.filter(url => url === metadataUrl).length !== INTEGRITY_ATTEMPTS) throw new Error(`Integrity failure (${cause}) was not re-fetched with its bound: ${JSON.stringify(urls)}`);
    if (JSON.stringify(await readdir(join(state, 'releases'))) !== JSON.stringify(before)) throw new Error(`Unverified target (${cause}) was cached.`);
    await unchanged(`Unverified target (${cause})`);
  };
  const entries = JSON.parse(good).entries.map(entry => entry.path === 'bin/virgo' ? { ...entry, content: tamperedCli.toString('base64') } : entry);
  const tamperedEntry = Buffer.from(JSON.stringify({ ...JSON.parse(good), entries }) + '\n');
  const integrityCases = [
    ['GitHub Release metadata does not match the selected tag.', { tagName: 'release-other' }],
    ['GitHub Release contains duplicate asset names.', { duplicate: MANIFEST_ID }],
    ['GitHub Release manifest is malformed.', { manifestBytes: Buffer.from('{"release":') }],
    ['Release manifest digest failed.', { digestOverride: '0'.repeat(64) }],
    ['GitHub Release manifest names a different release.', { release: older }],
    ['Release manifest must contain exactly one agent_host native archive for this platform.', { extraArtifact: true }],
    ['GitHub Release manifest points outside its pinned archive asset.', { sourceUrl: browserUrl(UNOFFICIAL, `${target}-${platform.os}-${platform.architecture}.vra`) }],
    ['GitHub Release archive hash differs from its manifest.', { archiveBytes: Buffer.concat([good, Buffer.from(' ')]), pinnedArchive: good }],
    ['Release archive identity does not match the manifest.', { archiveBytes: archive(older, targetCli) }],
    ['Release archive identity does not match the manifest.', { archiveBytes: archive(target, targetCli, target, foreign) }],
    ['Release archive does not contain its verified CLI and descriptor.', { archiveBytes: tamperedEntry }],
    ['Release descriptor names a different release.', { archiveBytes: archive(target, targetCli, older) }],
  ];
  for (const [cause, published] of integrityCases) await integrityClass(cause, published);

  // The upgrade completes on its own once a verified artifact arrives: the first
  // fetch serves tampered bytes, the automatic re-fetch serves R's verified archive.
  for (const [cause, published] of [
    ['GitHub Release archive hash differs from its manifest.', { firstArchive: archive(target, tamperedCli) }],
    ['Release manifest digest failed.', { firstManifest: Buffer.from(JSON.stringify({ release: target, artifacts: [], manifestDigest: '0'.repeat(64) })) }],
  ]) {
    await publish(published); await reset();
    await rm(join(state, 'releases', sha(targetCli)), { recursive: true, force: true });
    const result = success(command(virgo, upgrade(official), pinned));
    await dispatch('target', upgrade(official));
    if (!result.stderr.includes(cause) || /refused|target unavailable/u.test(result.stderr)) throw new Error(`Recovered integrity failure was misreported: ${result.stderr}`);
    if ((await downloads()).filter(url => url === metadataUrl).length !== 2) throw new Error('Recovery did not re-fetch exactly once.');
    if (!targetCli.equals(await readFile(cachedCli))) throw new Error('Recovered target was not cached.');
    await unchanged('Recovered target');
  }

  // Point 5: runtime/installation guards still run before target selection: a
  // pending interpreter migration or changed supervisor receipt never fetches R.
  await publish();
  const transition = join(dirname(installed.receiptPath), 'runtime-transition.json');
  await writeFile(transition, JSON.stringify({ planId: 'd'.repeat(64) }), { mode: 0o600 });
  await reset();
  rejected(command(virgo, upgrade(official), pinned), 'migration is pending');
  await absent(dispatchLog, 'Pending migration reached the target CLI.');
  if ((await downloads()).length) throw new Error('Pending migration downloaded the target.');
  await rm(transition);
  const receipt = await readFile(installed.receiptPath);
  await writeFile(installed.receiptPath, JSON.stringify({ ...JSON.parse(receipt), cliDigest: '0'.repeat(64) }), { mode: 0o600 });
  await reset();
  rejected(command(virgo, upgrade(official), pinned), 'Supervisor CLI differs');
  await absent(dispatchLog, 'Changed supervisor receipt reached the target CLI.');
  if ((await downloads()).length) throw new Error('Changed supervisor receipt downloaded the target.');
  await writeFile(installed.receiptPath, receipt, { mode: 0o600 });

  // Point 5: without --release the official current operator remains the selection.
  const implicit = ['upgrade', '--mode', 'host', '--machine', 'isolated', '--root', installationRoot];
  await reset();
  rejected(command(virgo, implicit, pinned), oldRefusal);
  await dispatch('old', [...implicit, '--release', older, '--github-repository', OFFICIAL]);
  if (apiDownloads(await downloads()).length) throw new Error('Implicit upgrade fetched a target.');
  await unchanged('Implicit upgrade');
  console.log(`PASS: ${cases} explicit-target upgrade dispatch checks on ${platform.os} ${platform.architecture}; real wrapper/launcher/Bun, 2.2.1-class installed Host and operator, isolated fixtures, no live Hub/Host/provider effects.`);
} finally { await rm(root, { recursive: true, force: true }); }
