import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, readdir, lstat, symlink, rename } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(join(await import('node:fs/promises').then(m => m.realpath(tmpdir())), 'virgo-launcher-test-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const newer = 'b'.repeat(64), older = 'a'.repeat(64);
const fixtureDir = join(root, 'official files with spaces'), bin = join(root, 'fixture bin');
await mkdir(fixtureDir, { recursive: true }); await mkdir(bin);
const metadataPath = join(fixtureDir, 'current.json');
const launcherPath = join(fixtureDir, 'launcher.js');
await writeFile(launcherPath, (await readFile(join(repository,'launcher.js'),'utf8')).replace(/const BUN_SHA = '[a-f0-9]+';/u, `const BUN_SHA = '${sha(await readFile(process.execPath))}';`));
const assetPath = join(fixtureDir, 'current cli');
const dispatchLog = join(root, 'dispatch.json');
const downloadLog = join(root, 'download.jsonl');
const environment = { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/zsh',
  VIRGO_TEST_FILES: fixtureDir, VIRGO_TEST_LAUNCHER: launcherPath, VIRGO_TEST_DISPATCH: dispatchLog, VIRGO_TEST_DOWNLOAD_LOG: downloadLog };
let fixtureHome;
const cli = marker => `#!/unusable/interpreter\nif(process.env.VIRGO_TEST_EXPECT_EXECUTABLE&&await import('node:fs/promises').then(m=>m.realpath(process.execPath))!==process.env.VIRGO_TEST_EXPECT_EXECUTABLE){console.error('supervisor interpreter mismatch');process.exit(88);}
await Bun.write(process.env.VIRGO_TEST_DISPATCH,JSON.stringify({marker:${JSON.stringify(marker)},args:process.argv.slice(2)}));\nconsole.log(JSON.stringify({ok:true,marker:${JSON.stringify(marker)}}));\nprocess.exit(Number(process.env.VIRGO_TEST_CLI_EXIT??0));\n`;
await writeFile(assetPath, cli('current'));
const current = { ...await Bun.file(join(repository, 'current.json')).json(), release: newer, cliSha256: sha(await readFile(assetPath)), launcherSha256: sha(await readFile(launcherPath)), operator: {release: newer,cliSha256:sha(await readFile(assetPath))} };
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
  const descriptor = Buffer.from(JSON.stringify({ release, adapterDirectory: 'adapters', daemonSupervision: { protocolVersion: 1, cliExecutable: 'bin/virgo' } })+'\n');
  const archive = { schemaVersion: 1, component: 'agent_host', release, platform: { os: 'macos', architecture: 'arm64' },
    entries: [['bin/virgo', cliBytes], ['release.json', descriptor]].map(([path, bytes]) => ({ path, kind: 'file', mode: 0o755, digest: sha(bytes), content: bytes.toString('base64') })) };
  const archiveBytes = Buffer.from(JSON.stringify(archive)+'\n'), digest = sha(archiveBytes);
  const releaseDirectory = join(installationRoot, 'releases', `${release}-${digest}`), handle = join(installationRoot, 'cache', digest);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(join(releaseDirectory, 'bin'), { recursive: true }); await mkdir(dirname(handle), { recursive: true });
  await writeFile(join(releaseDirectory, 'bin', 'virgo'), cliBytes, { mode: 0o555 }); await writeFile(join(releaseDirectory, 'release.json'), descriptor, { mode: 0o444 });
  await writeFile(handle, archiveBytes, { mode: 0o600 });
  await writeFile(join(directory, 'virgo.config.json'), JSON.stringify({ schemaVersion: 1, machine: target.machine, release, mode: instance === 'local-hub' ? 'local' : 'host' }), { mode: 0o600 });
  await writeFile(join(directory, 'installation-state.json'), JSON.stringify({ schemaVersion: 1, target, installedRelease: release,
    active: { releaseDirectory, artifact: { handle, artifact: { component: 'agent_host', release, platform: archive.platform, format: 'native_archive', digest } } } }), { mode: 0o600 });
  const executable = join(fixtureHome,'.local/share/virgo/bootstrap/bun/1.3.14/bin/bun');
  const info = await lstat(executable);
  const registration = join(installationRoot, 'processes', 'supervision', 'registration');
  await mkdir(registration, { recursive: true, mode: 0o700 });
  const receipt = { schemaVersion: 1, root: installationRoot, releaseDirectory, cli: join(releaseDirectory, 'bin', 'virgo'), cliDigest: sha(cliBytes),
    executable, executableIdentity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`, launchAgentsDirectory: join(fixtureHome, 'Library', 'LaunchAgents'), intervalSeconds: 5 };
  const receiptPath = join(registration, 'supervisor.json');
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  return { directory, releaseDirectory, handle, executable, receipt, receiptPath };

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
  fixtureHome = home;
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
  const selectedRoot = join(root, 'old installed root');
  for (const args of [ ['skill','list'], ['skill','install','--root',selectedRoot], ['skill','install','virgo-task','--root',selectedRoot],
    ['knowledge-setup','--mode','host','--root',selectedRoot,'--machine','isolated','--repository','space/repo','--manifest-directory',join(selectedRoot,'cache')],
    ['capability-setup','--mode','host','--root',selectedRoot,'--machine','isolated','--selection',join(root,'selection with spaces'),'--provider-hooks',join(root,'hooks with spaces'),'--github-repository','virgo-codes/virgo-release'],
    ['capability-setup','--mode','host','--root',selectedRoot,'--machine','isolated','--plan-id','retained-plan'] ]) {
    success(command(virgo, ['--directory',target.directory,...args], { ...env, VIRGO_TEST_FAIL: 'current.json' })); await dispatch('old', args);
  }
  for (const args of [ ['skill','install','--root',join(root,'another root')], ['skill','install'],
    ['knowledge-setup','--mode','host','--root',selectedRoot,'--machine','other','--repository','space/repo','--manifest-directory',join(selectedRoot,'cache')],
    ['capability-setup','--mode','host','--root',join(root,'another root'),'--machine','isolated','--plan-id','retained-plan'],
    ['capability-setup','--mode','host','--root',selectedRoot,'--machine','isolated','--instance','other','--plan-id','retained-plan'],
    ['capability-setup','--mode','local','--root',selectedRoot,'--machine','isolated','--plan-id','retained-plan'] ]) {
    await rm(dispatchLog, { force:true }); rejected(command(virgo, ['--directory',target.directory,...args],env),'differs');
    try { await readFile(dispatchLog); throw new Error('Target mismatch reached the installed CLI.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const hostRollback = ['rollback', '--mode', 'host', '--machine', 'isolated', '--root', join(root, 'old installed root'), '--plan-id', 'retained-plan'];
  success(command(virgo, hostRollback, env)); await dispatch('old', hostRollback);
  const localRoot = join(root, 'local retained root'); await installedFixture(localRoot, older, 'old-local', 'local-hub');
  const localDirectory = join(localRoot,'instances',encodeURIComponent('isolated\0agent_host\0local-hub'));
  for (const setup of ['knowledge-setup','capability-setup']) {
    const args=[setup,'--mode','local','--root',localRoot,'--machine','isolated','--plan-id','retained-plan'];
    success(command(virgo,['--directory',localDirectory,...args],env)); await dispatch('old-local',args);
  }
  const localRollback = ['rollback', '--mode', 'local', '--machine', 'isolated', '--root', localRoot, '--plan-id', 'retained-plan', '--manifest-directory', join(localRoot, 'cache')];
  success(command(virgo, localRollback, env)); await dispatch('old-local', localRollback);
  // The registered runtime is a different canonical executable from the acquisition package.
  const originalLauncher = join(root, 'published-7441-launcher.js');
  const old = spawnSync('git', ['show', '7441a5ef39489b3e3aedf16e3b60bc4433b197c2:launcher.js'], { cwd: repository });
  if (old.status !== 0) throw new Error('Missing exact published negative control.');
  const pendingNegative = join(root, 'bb1-pending-negative.js');
  const bb1 = spawnSync('git', ['show', 'bb1e2d68d2b04a997efc2695272ce8755e7dee2d:launcher.js'], { cwd: repository, encoding: 'utf8' });
  if (bb1.status !== 0) throw new Error('Missing exact reviewed pending negative control.');
  await writeFile(pendingNegative, bb1.stdout.replace(/const BUN_SHA = '[a-f0-9]+';/u, `const BUN_SHA = '${sha(await readFile(process.execPath))}';`));

  await writeFile(originalLauncher, old.stdout);
  for (const [installed, installationRoot, mode] of [[target, selectedRoot, 'host'],
      [await installedFixture(join(root, 'supervised local'), older, 'local-pin', 'local-hub'), join(root, 'supervised local'), 'local']]) {
    const pinnedEnv = { ...env, VIRGO_TEST_EXPECT_EXECUTABLE: installed.executable };
    const operations = [ ['--directory',installed.directory,'host','status'], ['--directory',installed.directory,'host','start'],
      ['install','--mode',mode,'--root',installationRoot,'--machine','isolated'],
      ['upgrade','--mode',mode,'--root',installationRoot,'--machine','isolated'],
      ['rollback','--mode',mode,'--root',installationRoot,'--machine','isolated','--plan-id','original-plan',
        ...(mode === 'local' ? ['--manifest-directory',join(installationRoot,'cache')] : [])] ];
    for (const args of operations) {
      await rm(dispatchLog, { force: true });
      rejected(command(process.execPath,[originalLauncher,...args],pinnedEnv),'interpreter mismatch');
      try { await readFile(dispatchLog); throw new Error('Old launcher wrote despite interpreter mismatch.'); } catch(error) { if(error.code!=='ENOENT')throw error; }
      success(command(virgo,args,pinnedEnv));
      await dispatch(['install','upgrade'].includes(args[0])?'current':mode==='host'?'old':'local-pin',
        ['install','upgrade'].includes(args[0])?[...args,'--release',newer,'--github-repository','virgo-codes/virgo-release']:args);
    }
    // The after receipt is already configured, but a response loss may leave the
    // product-owned marker. Even an old installed CLI must not bypass that marker.
    const transition = join(dirname(installed.receiptPath), 'runtime-transition.json');
    const planId = 'd'.repeat(64);
    await writeFile(transition, JSON.stringify({ planId }), { mode: 0o600 });
    success(command(installed.executable, [pendingNegative, ...operations[0]], pinnedEnv));
    await dispatch(mode === 'host' ? 'old' : 'local-pin', operations[0]);

    for (const args of [...operations, ['--directory', installed.directory, 'host', 'stop'],
        ['--directory', installed.directory, 'host', 'runtime', 'prepare'],
        ['--directory', installed.directory, 'host', 'runtime', 'apply', '--plan-id', 'e'.repeat(64)]]) {
      await rm(dispatchLog, { force: true }); await rm(downloadLog, { force: true });
      rejected(command(virgo, args, pinnedEnv), 'migration is pending');
      for (const path of [dispatchLog, downloadLog]) try { await readFile(path); throw new Error('Pending migration reached ordinary dispatch/download.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const apply = ['--directory', installed.directory, 'host', 'runtime', 'apply', '--plan-id', planId];
    for (let attempt = 0; attempt < 2; attempt++) {
      success(command(virgo, apply, pinnedEnv)); await dispatch('current', apply);
      if (JSON.parse(await readFile(transition)).planId !== planId) throw new Error('Launcher changed product-owned migration marker.');
    }
    // Product owns cleanup; once it clears its marker ordinary dispatch resumes.
    await rm(transition); success(command(virgo, operations[0], pinnedEnv));
    for (const invalid of [{ planId: 'invalid' }, { planId, extra: true }]) {
      await writeFile(transition, JSON.stringify(invalid), { mode: 0o600 });
      await rm(dispatchLog, { force: true }); rejected(command(virgo, apply, pinnedEnv), 'marker is invalid');
      try { await readFile(dispatchLog); throw new Error('Invalid marker reached operator.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await rm(transition); await symlink(installed.receiptPath, transition);
    await rm(dispatchLog, { force: true }); rejected(command(virgo, apply, pinnedEnv));
    try { await readFile(dispatchLog); throw new Error('Symlink marker reached operator.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(transition);
    const before = await readFile(installed.receiptPath);
    const refuse = async () => {
      for (const args of [operations[0],operations[2],operations[3],operations[4]]) {
        await rm(dispatchLog,{force:true}); await rm(downloadLog,{force:true}); rejected(command(virgo,args,pinnedEnv));
        for(const path of [dispatchLog,downloadLog])try{await readFile(path);throw new Error('Unverified receipt reached download/prepare.');}catch(error){if(error.code!=='ENOENT')throw error;}
      }
    };
    await rm(installed.receiptPath); await refuse();
    await symlink(installed.handle,installed.receiptPath); await refuse(); await rm(installed.receiptPath);
    await writeFile(installed.receiptPath,before,{mode:0o600});
    for(const change of [{cliDigest:'0'.repeat(64)},{root:join(root,'wrong root')},{executableIdentity:'0:0:0:0'},
        {executable:process.execPath},{releaseDirectory:join(root,'outside release')}]) {
      await writeFile(installed.receiptPath,JSON.stringify({...installed.receipt,...change})); await refuse();
    }
    await writeFile(installed.receiptPath,before);
    await rename(installed.executable,installed.executable+'.original');
    await symlink(installed.executable+'.original',installed.executable); await refuse(); await rm(installed.executable);
    await copyFile(installed.executable+'.original',installed.executable); await chmod(installed.executable,0o755); await refuse(); await rm(installed.executable);
    await rename(installed.executable+'.original',installed.executable);
    // Persistent receipts tolerate APFS device-number changes, retaining all other identity parts.
    await writeFile(installed.receiptPath,JSON.stringify({...installed.receipt,executableIdentity:'999'+installed.receipt.executableIdentity.slice(installed.receipt.executableIdentity.indexOf(':'))}));
    success(command(virgo,operations[0],pinnedEnv)); await writeFile(installed.receiptPath,before);
    const replacementPath=join(dirname(installed.receiptPath),'replacement.json');
    await writeFile(replacementPath,JSON.stringify({schemaVersion:1,before:installed.receipt,after:installed.receipt}),{mode:0o600});
    success(command(virgo,operations[3],pinnedEnv));
    await writeFile(replacementPath,JSON.stringify({schemaVersion:1,before:installed.receipt,after:{...installed.receipt,executable:process.execPath}})); await refuse(); await rm(replacementPath);
    if(!before.equals(await readFile(installed.receiptPath)))throw new Error('Delegation changed registration.');
  }
  const legacy = await installedFixture(join(root,'cellar registration root'),older,'legacy');
  const priorRuntime = join(root,'prior cellar','bun'); await mkdir(dirname(priorRuntime),{recursive:true}); await chmod(dirname(priorRuntime),0o775); await copyFile(process.execPath,priorRuntime); await chmod(priorRuntime,0o755);
  const info=await lstat(priorRuntime), oldReceipt={...legacy.receipt,executable:priorRuntime,executableIdentity:`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`};
  await writeFile(legacy.receiptPath,JSON.stringify(oldReceipt));
  rejected(command(virgo,['--directory',legacy.directory,'host','status'],env),'different runtime');
  success(command(virgo,['--directory',legacy.directory,'host','runtime','prepare'],{...env,VIRGO_TEST_EXPECT_EXECUTABLE:legacy.executable}));
  await dispatch('current',['--directory',legacy.directory,'host','runtime','prepare']);
  const fixedRuntime=join(home,'.local/share/virgo/bootstrap/bun/1.3.14/bin/bun');
  const runtimeBefore=await lstat(fixedRuntime), pinBefore=await readFile(join(home,'.local/share/virgo/bootstrap/config.json'));
  success(command('/bin/bash',[installerPath],env));
  const runtimeAfter=await lstat(fixedRuntime);
  if(runtimeBefore.ino!==runtimeAfter.ino || runtimeBefore.mtimeMs!==runtimeAfter.mtimeMs || !pinBefore.equals(await readFile(join(home,'.local/share/virgo/bootstrap/config.json'))))throw new Error('Matching acquisition repinned the configured runtime.');
  const configPath=join(home,'.local/share/virgo/bootstrap/config.json');
  await writeFile(configPath,JSON.stringify({schemaVersion:1,executable:priorRuntime}));
  await rm(dispatchLog,{force:true}); rejected(command(virgo,['install','--machine','x'],env),'configuration');
  rejected(command('/bin/bash',[installerPath],env),'configuration changed');
  await writeFile(configPath,pinBefore);
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
  const changed = cli('successor'); await writeFile(assetPath, changed); current.release = 'c'.repeat(64); current.cliSha256 = sha(changed); current.operator={release:current.release,cliSha256:current.cliSha256}; await writeFile(metadataPath, JSON.stringify(current));
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
  const concurrentHome=join(root,'concurrent cold acquisition');await mkdir(concurrentHome);
  const parallel=()=>new Promise((done,reject)=>{const child=spawn('/bin/bash',[installerPath],{env:{...environment,HOME:concurrentHome},stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('exit',status=>done({status,stderr}));});
  const attempts=await Promise.all([parallel(),parallel()]);
  if(!attempts.some(r=>r.status===0))throw Error(JSON.stringify(attempts));
  const concurrentRuntime=join(concurrentHome,'.local/share/virgo/bootstrap/bun/1.3.14/bin/bun'), initial=await lstat(concurrentRuntime), concurrentConfig=await readFile(join(concurrentHome,'.local/share/virgo/bootstrap/config.json'));
  success(command('/bin/bash',[installerPath],{...environment,HOME:concurrentHome}));
  const retained=await lstat(concurrentRuntime);if(retained.ino!==initial.ino||retained.mtimeMs!==initial.mtimeMs||!concurrentConfig.equals(await readFile(join(concurrentHome,'.local/share/virgo/bootstrap/config.json'))))throw Error('Concurrent acquisition replaced winning Bun/config');cases++;
  success(command(join(concurrentHome,'.local/bin/virgo'),['--help'],{...environment,HOME:concurrentHome}));
  const bashHome = join(root, 'bash user'); await mkdir(bashHome);
  success(command('/bin/bash', [installerPath], { ...environment, HOME: bashHome, SHELL: '/bin/bash' }));
  success(command('/bin/bash', ['-l','-c','virgo --help'], { ...environment, HOME: bashHome, SHELL: '/bin/bash' }));
  console.log(`PASS: ${cases} composed acquisition/PATH/install/upgrade/recovery/installed-dispatch/failure/retry checks; real Bash/zsh/Bun, isolated HTTPS fixtures, no live Hub/Host/provider effects.`);
} finally { await rm(root, { recursive: true, force: true }); }
