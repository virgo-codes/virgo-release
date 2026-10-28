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
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(await realpath(tmpdir()), 'virgo-target-dispatch-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const older = 'a'.repeat(64), target = 'f'.repeat(64);
const platform = { os: 'macos', architecture: 'arm64' };
const fixtureDir = join(root, 'official files'), github = join(root, 'github releases'), bin = join(root, 'fixture bin');
await mkdir(fixtureDir, { recursive: true }); await mkdir(github); await mkdir(bin);
const launcherPath = join(fixtureDir, 'launcher.js'), assetPath = join(fixtureDir, 'current cli');
const dispatchLog = join(root, 'dispatch.json'), downloadLog = join(root, 'download.jsonl');
await writeFile(launcherPath, (await readFile(join(repository, 'launcher.js'), 'utf8')).replace(/const BUN_SHA = '[a-f0-9]+';/u, `const BUN_SHA = '${sha(await readFile(process.execPath))}';`));
const environment = { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/zsh', VIRGO_TEST_FILES: fixtureDir, VIRGO_TEST_GITHUB: github,
  VIRGO_TEST_LAUNCHER: launcherPath, VIRGO_TEST_DISPATCH: dispatchLog, VIRGO_TEST_DOWNLOAD_LOG: downloadLog };
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
const current = { ...await Bun.file(join(repository, 'current.json')).json(), release: older, cliSha256: sha(oldCli), launcherSha256: sha(await readFile(launcherPath)),
  operator: { release: older, cliSha256: sha(oldCli) } };
delete current.platforms;
await writeFile(join(fixtureDir, 'current.json'), JSON.stringify(current));
const runtime = join(fixtureDir, 'bun-darwin-aarch64'); await mkdir(runtime); await copyFile(process.execPath, join(runtime, 'bun'));
const zip = join(fixtureDir, 'bun.zip');
if (spawnSync('/usr/bin/zip', ['-q', '-r', zip, 'bun-darwin-aarch64'], { cwd: fixtureDir }).status !== 0) throw new Error('Could not prepare isolated runtime archive.');
const installerPath = join(fixtureDir, 'install.sh');
await writeFile(installerPath, (await readFile(join(repository, 'install.sh'), 'utf8'))
  .replace(/readonly BUN_ARCHIVE_SHA='[a-f0-9]+'/u, `readonly BUN_ARCHIVE_SHA='${sha(await readFile(zip))}'`)
  .replace(/readonly BUN_SHA='[a-f0-9]+'/u, `readonly BUN_SHA='${sha(await readFile(process.execPath))}'`));
const downloader = join(root, 'download.js');
await writeFile(downloader, `import{readFile,writeFile,appendFile,lstat}from'node:fs/promises';import{join}from'node:path';
const args=process.argv.slice(2),url=args.at(-3),out=args.at(-1);await appendFile(process.env.VIRGO_TEST_DOWNLOAD_LOG,JSON.stringify(args)+'\\n');
if(args.at(-2)!=='--output'||!url.startsWith('https://'))process.exit(93);
if(process.env.VIRGO_TEST_FAIL&&url.includes(process.env.VIRGO_TEST_FAIL))process.exit(23);
const release=/^https:\\/\\/github\\.com\\/virgo-codes\\/virgo-release\\/releases\\/download\\/(release-[a-f0-9]{64})\\/([A-Za-z0-9._-]+)$/u.exec(url);
let source=release&&await lstat(join(process.env.VIRGO_TEST_GITHUB,release[1],release[2])).then(()=>join(process.env.VIRGO_TEST_GITHUB,release[1],release[2]),()=>null);
source??=url.endsWith('/current.json')?join(process.env.VIRGO_TEST_FILES,'current.json'):url.endsWith('/launcher.js')?process.env.VIRGO_TEST_LAUNCHER:url.endsWith('/bun-darwin-aarch64.zip')?join(process.env.VIRGO_TEST_FILES,'bun.zip'):url.endsWith('/virgo-macos-arm64')?join(process.env.VIRGO_TEST_FILES,'current cli'):null;if(!source)process.exit(94);
let bytes=await readFile(source);if(process.env.VIRGO_TEST_TAMPER&&url.includes(process.env.VIRGO_TEST_TAMPER))bytes=Buffer.concat([bytes,Buffer.from('tamper')]);await writeFile(out,bytes);`);
await writeFile(join(bin, 'curl'), `#!/bin/bash\nexec ${shellQuote(process.execPath)} ${shellQuote(downloader)} "$@"\n`, { mode: 0o700 });
await writeFile(join(bin, 'gh'), '#!/bin/bash\nexit 91\n', { mode: 0o700 });

let cases = 0;
const command = (executable, args, env) => { const result = spawnSync(executable, args, { env, encoding: 'utf8' }); if (result.error) throw result.error; return result; };
const success = result => { if (result.status !== 0) throw new Error(JSON.stringify(result)); cases++; return result; };
const rejected = (result, contains) => { if (result.status === 0 || (contains && !result.stderr.includes(contains))) throw new Error(JSON.stringify(result)); cases++; return result; };
const absent = async (path, message) => { try { await readFile(path); throw new Error(message); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
async function dispatch(marker, args) {
  const actual = JSON.parse(await readFile(dispatchLog, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify({ marker, args })) throw new Error(JSON.stringify({ actual, marker, args }));
}
const downloads = async () => (await readFile(downloadLog, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).at(-3));
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function archive(release, cliBytes, descriptorRelease = release) {
  const descriptor = Buffer.from(JSON.stringify({ release: descriptorRelease, adapterDirectory: 'adapters', daemonSupervision: { protocolVersion: 1, cliExecutable: 'bin/virgo' } }) + '\n');
  return Buffer.from(JSON.stringify({ schemaVersion: 1, component: 'agent_host', release, platform,
    entries: [['bin/virgo', cliBytes], ['release.json', descriptor]].map(([path, bytes]) => ({ path, kind: 'file', mode: 0o755, digest: sha(bytes), content: bytes.toString('base64') })) }) + '\n');
}
function manifest(release, archiveBytes, source) {
  const artifacts = [{ component: 'agent_host', release, platform, format: 'native_archive', digest: sha(archiveBytes), source }];
  return Buffer.from(JSON.stringify({ version: '2.2.8', release, artifacts, manifestDigest: sha(canonical({ release, artifacts })) }) + '\n');
}
/** Publish the target as each supported distribution: manifests, preview bundle and GitHub release assets. */
async function publish(name, { archiveBytes = archive(target, targetCli), manifestBytes, bootstrap = targetCli } = {}) {
  const manifests = join(root, `${name} manifests`), bundle = join(root, `${name} bundle`), tag = join(github, `release-${target}`);
  for (const path of [manifests, bundle, tag]) { await rm(path, { recursive: true, force: true }); await mkdir(path, { recursive: true, mode: 0o700 }); }
  const local = manifestBytes ?? manifest(target, archiveBytes, { kind: 'local', path: join(manifests, `${target}.vra`) });
  await writeFile(join(manifests, `${target}.vra`), archiveBytes); await writeFile(join(manifests, `${target}.json`), local);
  const preview = manifestBytes ?? manifest(target, archiveBytes, { kind: 'local', path: join(bundle, `${target}.vra`) });
  await writeFile(join(bundle, `${target}.vra`), archiveBytes); await writeFile(join(bundle, `${target}.json`), preview); await writeFile(join(bundle, 'virgo'), bootstrap, { mode: 0o755 });
  await writeFile(join(bundle, 'SHA256SUMS'), [[`${target}.json`, preview], [`${target}.vra`, archiveBytes], ['virgo', bootstrap]].map(([file, bytes]) => `${sha(bytes)}  ${file}`).join('\n') + '\n');
  const asset = `${target}-macos-arm64.vra`;
  await writeFile(join(tag, asset), archiveBytes);
  await writeFile(join(tag, `${target}.json`), manifestBytes ?? manifest(target, archiveBytes,
    { kind: 'https', url: `https://github.com/virgo-codes/virgo-release/releases/download/release-${target}/${asset}` }));
  return [['--manifest-directory', manifests], ['--bundle', bundle], ['--github-repository', 'virgo-codes/virgo-release']];
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
    executable, executableIdentity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`, launchAgentsDirectory: join(home, 'Library', 'LaunchAgents'), intervalSeconds: 5 }), { mode: 0o600 });
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
  const upgrade = (distribution, extra = []) => ['upgrade', '--mode', 'host', '--machine', 'isolated', '--root', installationRoot, '--release', target, ...distribution, ...extra];

  // The target's own checks govern the old installed Host through every
  // distribution; the request reaches it byte-for-byte, independent from the
  // official channel metadata and its pinned 2.2.1-class operator.
  for (const distribution of await publish('verified')) {
    for (const extra of [['--preflight-only', 'true'], [], ['--activate', 'false']]) {
      const args = upgrade(distribution, extra);
      await rm(dispatchLog, { force: true }); await rm(downloadLog, { force: true });
      const result = success(command(virgo, args, { ...pinned, VIRGO_TEST_FAIL: 'current.json' }));
      await dispatch('target', args);
      if (result.stderr.includes('could not be inspected') || JSON.parse(result.stdout).receipts !== 1) throw new Error(JSON.stringify(result));
      if ((await downloads()).some(url => url.endsWith('/current.json') || url.endsWith('/virgo-macos-arm64'))) throw new Error('Target dispatch consulted the independent current operator.');
      if (!before.equals(await evidence())) throw new Error('Target dispatch changed receipts or installation state.');
    }
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

  // A wrong or unverifiable target is never cached or run; the launcher logs
  // and keeps the current behaviour: the official operator with the exact request.
  const tamperedCli = Buffer.from(cli('tampered', 2));
  const wrongArchive = archive(target, targetCli);
  const variants = [
    ['archive digest differs from its manifest', { archiveBytes: Buffer.concat([wrongArchive, Buffer.from(' ')]), manifestBytes: undefined }, { tamperArchive: true }],
    ['archive CLI entry differs from its digest', { archiveBytes: Buffer.from(JSON.stringify({ ...JSON.parse(archive(target, targetCli)), entries: JSON.parse(archive(target, targetCli)).entries.map(entry => entry.path === 'bin/virgo' ? { ...entry, content: tamperedCli.toString('base64') } : entry) }) + '\n') }],
    ['archive names another release', { archiveBytes: archive(older, targetCli) }],
    ['descriptor names another release', { archiveBytes: archive(target, targetCli, older) }],
    ['manifest digest is wrong', { manifestBytes: Buffer.from(JSON.stringify({ ...JSON.parse(manifest(target, wrongArchive, { kind: 'local', path: '/absent.vra' })), manifestDigest: '0'.repeat(64) })) }],
    ['bundle bootstrap differs from the archive CLI', { bootstrap: tamperedCli }, { bundleOnly: true }],
  ];
  for (const [reason, published, options = {}] of variants) {
    const distributions = await publish('wrong', published);
    if (options.tamperArchive) for (const [flag, value] of distributions) {
      // Keep each manifest's digest pinned to the original archive bytes.
      const archiveBytes = archive(target, targetCli);
      if (flag === '--github-repository') await writeFile(join(github, `release-${target}`, `${target}.json`), manifest(target, archiveBytes, { kind: 'https', url: `https://github.com/virgo-codes/virgo-release/releases/download/release-${target}/${target}-macos-arm64.vra` }));
      else { const manifestBytes = manifest(target, archiveBytes, { kind: 'local', path: join(value, `${target}.vra`) }); await writeFile(join(value, `${target}.json`), manifestBytes);
        if (flag === '--bundle') await writeFile(join(value, 'SHA256SUMS'), [[`${target}.json`, manifestBytes], [`${target}.vra`, await readFile(join(value, `${target}.vra`))], ['virgo', targetCli]].map(([file, bytes]) => `${sha(bytes)}  ${file}`).join('\n') + '\n'); }
    }
    for (const distribution of options.bundleOnly ? distributions.filter(([flag]) => flag === '--bundle') : distributions) {
      const args = upgrade(distribution), cached = await readdir(join(state, 'releases'));
      await rm(dispatchLog, { force: true });
      const result = rejected(command(virgo, args, pinned), 'old: Provider replacement receipts could not be inspected.');
      await dispatch('old', args);
      if (!result.stderr.includes('could not be authenticated')) throw new Error(`Unverified target (${reason}) was not logged: ${result.stderr}`);
      if (JSON.stringify(await readdir(join(state, 'releases'))) !== JSON.stringify(cached)) throw new Error(`Unverified target (${reason}) was cached.`);
      if (!before.equals(await evidence())) throw new Error(`Unverified target (${reason}) changed receipts or installation state.`);
    }
  }
  // An unavailable target distribution (absent assets/manifests) keeps the current behaviour too.
  const verified = await publish('verified');
  for (const [distribution, unavailable] of [[['--manifest-directory', join(root, 'absent manifests')], pinned], [['--bundle', join(root, 'absent bundle')], pinned],
      [verified[2], { ...pinned, VIRGO_TEST_FAIL: `/release-${target}/` }]]) {
    const args = upgrade(distribution);
    await rm(dispatchLog, { force: true });
    rejected(command(virgo, args, unavailable), 'old: Provider replacement receipts could not be inspected.'); await dispatch('old', args);
  }

  // Runtime/installation guards still run before target selection: a pending
  // interpreter migration or changed supervisor receipt never reaches the target.
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
  rejected(command(virgo, implicit, pinned), 'old: Provider replacement receipts could not be inspected.');
  await dispatch('old', [...implicit, '--release', older, '--github-repository', 'virgo-codes/virgo-release']);
  if (!before.equals(await evidence())) throw new Error('Upgrade dispatch changed receipts or installation state.');
  console.log(`PASS: ${cases} explicit-target upgrade dispatch checks; real launcher/Bun, 2.2.1-class installed Host and operator, isolated fixtures, no live Hub/Host/provider effects.`);
} finally { await rm(root, { recursive: true, force: true }); }
