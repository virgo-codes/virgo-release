import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, readdir, lstat, symlink, rename } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { platform, bunPackage, cliAsset, loginShell, profileName, supervisorDirectory } from './fixture-curl.js';

// Runs on macOS arm64, or on Linux x64 with VIRGO_TEST_BUN_ARCHIVE naming the
// pinned Bun 1.3.14 zip (as tests/target-dispatch.test.js).
if (!platform) throw new Error('Run on macOS arm64 or Linux x64.');
const linux = platform.os === 'linux';
if (linux && !process.env.VIRGO_TEST_BUN_ARCHIVE) throw new Error('On Linux x64, set VIRGO_TEST_BUN_ARCHIVE to the pinned Bun 1.3.14 zip.');

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
const environment = { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: loginShell,
  VIRGO_TEST_FILES: fixtureDir, VIRGO_TEST_LAUNCHER: launcherPath, VIRGO_TEST_DISPATCH: dispatchLog, VIRGO_TEST_DOWNLOAD_LOG: downloadLog };
let fixtureHome;
const cli = marker => `#!/unusable/interpreter\nif(process.env.VIRGO_TEST_EXPECT_EXECUTABLE&&await import('node:fs/promises').then(m=>m.realpath(process.execPath))!==process.env.VIRGO_TEST_EXPECT_EXECUTABLE){console.error('supervisor interpreter mismatch');process.exit(88);}
let bridgeKind=null;
if(process.env.VIRGO_TEST_RUN_PRODUCT_BRIDGE==='1'){
 const{refreshOfficialLauncher,LAUNCHER_REFRESH_PENDING}=await import(process.env.VIRGO_TEST_PRODUCT_REFRESH_HELPER);
 const refresh=await refreshOfficialLauncher('bridge',process.env.VIRGO_TEST_BOUND_LAUNCHER_SHA);bridgeKind=refresh.kind;
 if(refresh.kind==='cancelled'||refresh.kind==='unsafe')process.exit(refresh.exitCode??1);
 if(refresh.kind==='pending')console.error(LAUNCHER_REFRESH_PENDING);
}
if(process.env.VIRGO_TEST_EFFECT_LOG)await import('node:fs/promises').then(m=>m.appendFile(process.env.VIRGO_TEST_EFFECT_LOG,JSON.stringify({marker:${JSON.stringify(marker)},args:process.argv.slice(2),guard:process.env.VIRGO_LAUNCHER_REFRESH_ONCE??null,bridgeKind})+'\\n'));
await Bun.write(process.env.VIRGO_TEST_DISPATCH,JSON.stringify({marker:${JSON.stringify(marker)},args:process.argv.slice(2)}));\nconsole.log(JSON.stringify({ok:true,marker:${JSON.stringify(marker)}}));\nprocess.exit(Number(process.env.VIRGO_TEST_CLI_EXIT??0));\n`;
await writeFile(assetPath, cli('current'));
// A single-platform channel for this runner; the published per-platform selection is not a fixture.
const { platforms: _published, ...official } = await Bun.file(join(repository, 'current.json')).json();
const current = { ...official, platform, release: newer, cliSha256: sha(await readFile(assetPath)), launcherSha256: sha(await readFile(launcherPath)), operator: {release: newer,cliSha256:sha(await readFile(assetPath))} };
await writeFile(metadataPath, JSON.stringify(current));
const zip = join(fixtureDir, 'bun.zip');
let installer = await readFile(join(repository, 'install.sh'), 'utf8');
if (linux) {
  await copyFile(process.env.VIRGO_TEST_BUN_ARCHIVE, zip);
  if (sha(await readFile(zip)) !== '951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f') throw new Error('Wrong Linux Bun fixture archive.');
} else {
  const runtime = join(fixtureDir, bunPackage); await mkdir(runtime);
  await copyFile(process.execPath, join(runtime, 'bun'));
  if (spawnSync('/usr/bin/zip', ['-q', '-r', zip, bunPackage], { cwd: fixtureDir }).status !== 0) throw new Error('Could not prepare isolated runtime archive.');
  installer = installer.replace(/readonly BUN_ARCHIVE_SHA='[a-f0-9]+'/u, `readonly BUN_ARCHIVE_SHA='${sha(await readFile(zip))}'`)
    .replace(/readonly BUN_SHA='[a-f0-9]+'/u, `readonly BUN_SHA='${sha(await readFile(process.execPath))}'`);
}
const installerPath = join(fixtureDir, 'install.sh'); await writeFile(installerPath, installer);
// The shared stub serves this runner's exact acquisition URLs (tests/fixture-curl.js).
const downloader = join(repository, 'tests', 'fixture-curl.js');
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
  const archive = { schemaVersion: 1, component: 'agent_host', release, platform,
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
    executable, executableIdentity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`, launchAgentsDirectory: supervisorDirectory(fixtureHome), intervalSeconds: 5 };
  const receiptPath = join(registration, 'supervisor.json');
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  return { directory, releaseDirectory, handle, executable, receipt, receiptPath };

}
try {
  const coldHome = join(root, 'interrupted first acquisition'); await mkdir(coldHome);
  rejected(command('/bin/bash', [installerPath], { ...environment, HOME: coldHome, VIRGO_TEST_TAMPER: cliAsset }));
  for (const missing of [join(coldHome,'.local','bin','virgo'),join(coldHome,profileName)]) {
    try { await readFile(missing); throw new Error('Failed cold acquisition published a partial command/profile.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  success(command('/bin/bash', [installerPath], { ...environment, HOME: coldHome }));
  success(command(loginShell, ['-l','-c','virgo --help'], { ...environment, HOME: coldHome }));
  // A caller-made refresh hint cannot bypass the stable entry's module hash.
  const coldPackages=(await readdir(join(coldHome,'.local/share/virgo/launcher/packages'))).filter(name=>name.startsWith('package-'));
  if(coldPackages.length!==1)throw Error('Unexpected cold acquisition custody.');
  const coldModule=join(coldHome,'.local/share/virgo/launcher/packages',coldPackages[0],'launcher.js'),coldBytes=await readFile(coldModule);
  await writeFile(coldModule,Buffer.concat([coldBytes,Buffer.from('\n// corrupted module\n')]));
  rejected(command(join(coldHome,'.local/bin/virgo'),['--help'],{...environment,HOME:coldHome,VIRGO_LAUNCHER_REFRESH_ONCE:'1'}),'launcher checksum');
  await writeFile(coldModule,coldBytes);

  const home = join(root, 'fresh user with spaces'); await mkdir(home);
  fixtureHome = home;
  const env = { ...environment, HOME: home }, virgo = join(home, '.local', 'bin', 'virgo');
  await writeFile(join(home, profileName), '# retained operator profile\nexport RETAINED_VIRGO_TEST=yes\n');
  if (command('/bin/bash', ['-c', 'command -v bun'], env).status === 0) throw new Error('Fixture unexpectedly has external Bun.');
  success(command('/bin/bash', [installerPath], env));
  const profile = await readFile(join(home, profileName), 'utf8');
  if (!profile.startsWith('# retained operator profile\nexport RETAINED_VIRGO_TEST=yes\n') || !profile.includes('# Virgo public command')) throw new Error('Profile content was not preserved.');
  // The new login shell loads the actual generated profile; no PATH export is taught to the user.
  success(command(loginShell, ['-l', '-c', 'command -v virgo; virgo --help'], env));
  success(command(virgo, ['--help'], env));
  // Profile shape is checked before stable-entry publication, without changing the old entry.
  const profilePath=join(home,profileName), profileBackup=join(home,profileName+'.verified-backup');
  const oldEntry=await readFile(virgo),oldEntryInfo=await lstat(virgo),validProfile=await readFile(profilePath);
  for(const kind of ['directory','unreadable','symlink']){
    await rename(profilePath,profileBackup);
    try{
      if(kind==='directory')await mkdir(profilePath,{mode:0o700});
      else if(kind==='symlink')await symlink(profileBackup,profilePath);
      else{await writeFile(profilePath,'# unreadable owned profile\n',{mode:0o600});await chmod(profilePath,0);}
      const before=await lstat(profilePath);
      rejected(command('/bin/bash',[installerPath],env),'shell profile');
      const after=await lstat(profilePath),entryAfter=await lstat(virgo);
      if(after.ino!==before.ino||after.mode!==before.mode||after.size!==before.size||after.mtimeMs!==before.mtimeMs||entryAfter.ino!==oldEntryInfo.ino||!oldEntry.equals(await readFile(virgo)))throw Error(`Invalid ${kind} profile changed current profile or entry.`);
      if(kind==='directory'&&(await readdir(profilePath)).length)throw Error('Profile temporary was moved into an invalid directory.');
    }finally{if(kind==='unreadable')await chmod(profilePath,0o600);await rm(profilePath,{recursive:true,force:true});await rename(profileBackup,profilePath);}
  }
  // A failed final rename leaves a valid refresh profile and current wrapper untouched.
  const renameBin=join(root,'fail-final-wrapper-rename');await mkdir(renameBin);
  await writeFile(join(renameBin,'mv'),`#!/bin/bash\nfor destination;do :;done\nif [[ "$destination" == "$VIRGO_TEST_REJECT_WRAPPER" ]];then exit 91;fi\nexec /bin/mv "$@"\n`,{mode:0o700});
  const profileBeforeRename=await lstat(profilePath);
  rejected(command('/bin/bash',[installerPath],{...env,PATH:renameBin+':'+env.PATH,VIRGO_TEST_REJECT_WRAPPER:virgo}));
  const profileAfterRename=await lstat(profilePath),entryAfterRename=await lstat(virgo);
  if(profileAfterRename.ino!==profileBeforeRename.ino||profileAfterRename.mtimeMs!==profileBeforeRename.mtimeMs||profileAfterRename.mode!==profileBeforeRename.mode||!validProfile.equals(await readFile(profilePath))||entryAfterRename.ino!==oldEntryInfo.ino||!oldEntry.equals(await readFile(virgo)))throw Error('Final wrapper rename failure changed a valid current profile or entry.');
  success(command(virgo,['--help'],env));
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
    const result = success(command(virgo, args, env)); await dispatch('current', args);
    // Only the official repository consults its GitHub release; this fixture serves none.
    if (result.stderr.includes('target unavailable') !== (distro === '--github-repository')) throw new Error(`Unexpected target dispatch outcome for ${distro}: ${result.stderr}`);
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
  // bb1e2d6 pins one runtime hash; on Linux that is the configured pinned Linux Bun (launcher.js:14).
  const bb1Runtime = linux ? '9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74' : sha(await readFile(process.execPath));
  await writeFile(pendingNegative, bb1.stdout.replace(/const BUN_SHA = '[a-f0-9]+';/u, `const BUN_SHA = '${bb1Runtime}';`));
  // Both historical launchers accept only macOS arm64 metadata and installed
  // artifacts (7441a5e metadata()/installedCLI(); bb1e2d6 :67,:114). On Linux they
  // refuse the runner's own fixtures before any dispatch, so each control there
  // asserts that platform refusal and that nothing ran, instead of its macOS outcome.
  const historicalRefusal = args => ['install', 'upgrade'].includes(args[0]) ? 'Official current metadata is invalid' : 'Installation receipt and selected release differ';

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
      rejected(command(process.execPath,[originalLauncher,...args],pinnedEnv),linux?historicalRefusal(args):'interpreter mismatch');
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
    if (linux) {
      await rm(dispatchLog, { force: true });
      rejected(command(installed.executable, [pendingNegative, ...operations[0]], pinnedEnv), historicalRefusal(operations[0]));
      try { await readFile(dispatchLog); throw new Error('Historical launcher dispatched a Linux installation.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      success(command(installed.executable, [pendingNegative, ...operations[0]], pinnedEnv));
      await dispatch(mode === 'host' ? 'old' : 'local-pin', operations[0]);
    }

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
  // A prior Homebrew/Linuxbrew-style runtime under a group-writable Cellar ancestor; the
  // historical-interpreter checks (launcher.js:298-307) are the same on both platforms.
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
  const oldWrapper = await readFile(virgo), oldProfile = await readFile(join(home, profileName));
  rejected(command('/bin/bash', [installerPath], { ...env, VIRGO_TEST_TAMPER: 'launcher.js' }));
  if (!oldWrapper.equals(await readFile(virgo)) || !oldProfile.equals(await readFile(join(home, profileName)))) throw new Error('Failed acquisition replaced the previous command/profile.');
  success(command(virgo, ['--help'], env));
  // ZIP integrity remains mandatory on acquisition WITHOUT an existing trusted pin.
  // A valid repeat now deliberately reuses that exact pin and never requests a ZIP.
  for (const behavior of [{ VIRGO_TEST_FAIL: `${bunPackage}.zip` }, { VIRGO_TEST_TAMPER: `${bunPackage}.zip` }, { VIRGO_TEST_INTERRUPT: `${bunPackage}.zip` }]) {
    const unpinned = await mkdtemp(join(root, 'unpinned archive guard-'));
    rejected(command('/bin/bash', [installerPath], { ...env, HOME: unpinned, ...behavior }));
    for (const path of [join(unpinned,'.local/bin/virgo'),join(unpinned,profileName)]) {
      try { await readFile(path); throw new Error('Unverified archive published command/profile.'); } catch(error) { if(error.code!=='ENOENT')throw error; }
    }
  }
  const refreshRuntimeBefore=await lstat(target.executable), refreshProfileBefore=await lstat(join(home,profileName));
  await rm(downloadLog,{force:true});
  success(command('/bin/bash',[installerPath],{...env,VIRGO_TEST_FAIL:`${bunPackage}.zip`}));
  const refreshRequests=(await readFile(downloadLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  if(refreshRequests.some(args=>args.at(-3).includes(`${bunPackage}.zip`)))throw new Error('Pinned repeat downloaded Bun ZIP.');
  const refreshRuntimeAfter=await lstat(target.executable), refreshProfileAfter=await lstat(join(home,profileName));
  if(refreshRuntimeBefore.ino!==refreshRuntimeAfter.ino||refreshRuntimeBefore.mtimeMs!==refreshRuntimeAfter.mtimeMs||refreshProfileBefore.ino!==refreshProfileAfter.ino||refreshProfileBefore.mtimeMs!==refreshProfileAfter.mtimeMs||!oldProfile.equals(await readFile(join(home,profileName))))throw new Error('Valid refresh changed Bun/profile identity.');
  await rm(downloadLog,{force:true});
  const offlineStarted=performance.now();
  const offlineStatusArgs=['--directory',target.directory,'host','status'];
  success(command(virgo,offlineStatusArgs,{...env,VIRGO_TEST_FAIL:'current.json'}));await dispatch('old',offlineStatusArgs);
  try { await readFile(downloadLog); throw new Error('Offline --directory status attempted refresh/network.'); } catch(error) { if(error.code!=='ENOENT')throw error; }
  if(performance.now()-offlineStarted>=9000)throw new Error('Offline installed command incurred refresh work budget.');

  // A new selected CLI fails download/checksum before caller dispatch, retaining the installed target.
  const changed = cli('successor'); await writeFile(assetPath, changed); current.release = 'c'.repeat(64); current.cliSha256 = sha(changed); current.operator={release:current.release,cliSha256:current.cliSha256}; await writeFile(metadataPath, JSON.stringify(current));
  rejected(command(virgo, ['upgrade','--mode','host','--machine','host'], { ...env, VIRGO_TEST_FAIL: cliAsset }));
  rejected(command(virgo, ['upgrade','--mode','host','--machine','host'], { ...env, VIRGO_TEST_TAMPER: cliAsset }), 'checksum');
  if (!beforeState.equals(await readFile(join(target.directory, 'installation-state.json')))) throw new Error('Failed upgrade modified the old installation.');
  success(command(virgo, ['upgrade','--mode','host','--machine','host'], env));
  await dispatch('successor', ['upgrade','--mode','host','--machine','host','--release',current.release,'--github-repository','virgo-codes/virgo-release']);
  success(command(virgo, installedArgs, env)); await dispatch('old', installedArgs);
  const forwarded = command(virgo, ['install','--machine','exit-test'], { ...env, VIRGO_TEST_CLI_EXIT: '7' });
  if (forwarded.status !== 7) throw new Error('CLI exit status changed.'); cases++;
  success(command('/bin/bash', [installerPath], env));
  if (!oldProfile.equals(await readFile(join(home, profileName)))) throw new Error('Repeat acquisition duplicated profile content.');
  success(command(loginShell, ['-l','-c','virgo --help'], env));
  if (process.env.VIRGO_TEST_PRODUCT_REFRESH_HELPER) {
    const baseLauncher=await readFile(launcherPath), effectLog=join(root,'refresh-effects.jsonl');
    const observed=async()=> (await readFile(downloadLog,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const effects=async()=> (await readFile(effectLog,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    const publish=async bytes=>{await writeFile(launcherPath,bytes);current.launcherSha256=sha(bytes);await writeFile(metadataPath,JSON.stringify(current));};
    const resetRefresh=async()=>{await rm(downloadLog,{force:true});await rm(effectLog,{force:true});await rm(dispatchLog,{force:true});};
    const extra={VIRGO_TEST_PRODUCT_REFRESH_HELPER:process.env.VIRGO_TEST_PRODUCT_REFRESH_HELPER,VIRGO_TEST_RUN_PRODUCT_BRIDGE:'1',VIRGO_TEST_BOUND_LAUNCHER_SHA:sha(baseLauncher),VIRGO_TEST_EFFECT_LOG:effectLog};
    for (const variant of ['bound','third-sha']) {
      await publish(Buffer.concat([baseLauncher,Buffer.from('\n// older self-refresh fixture A\n')]));
      success(command('/bin/bash',[installerPath],env));
      const targetBytes=variant==='bound'?baseLauncher:Buffer.concat([baseLauncher,Buffer.from('\n// third reviewed-source fixture X\n')]);
      await publish(targetBytes);
      const nextBytes=Buffer.concat([baseLauncher,Buffer.from('\n// next published fixture C\n')]);
      const nextLauncher=join(fixtureDir,'next-launcher.js'),nextMetadata=join(fixtureDir,'next-current.json');
      await writeFile(nextLauncher,nextBytes);await writeFile(nextMetadata,JSON.stringify({...current,launcherSha256:sha(nextBytes)}));
      await resetRefresh();
      const args=['upgrade','--mode','host','--machine','host','--root',quoted];
      success(command(virgo,args,{...env,...extra,VIRGO_TEST_REFRESH_NEXT_LAUNCHER:nextLauncher,VIRGO_TEST_REFRESH_NEXT_METADATA:nextMetadata}));
      const rows=await effects();if(rows.length!==1||rows[0].marker!=='successor'||rows[0].guard!==null||JSON.stringify(rows[0].args)!==JSON.stringify([...args,'--release',current.release,'--github-repository','virgo-codes/virgo-release']))throw Error('Refresh/bridge replayed or changed the one operation, or leaked the guard.');
      const requests=await observed(),acquisitions=requests.filter(args=>args.at(-3).endsWith('/install.sh'));
      if(acquisitions.length!==(variant==='bound'?1:2))throw Error(`Wrong bounded acquisition count for ${variant}: ${acquisitions.length}`);
      if(requests.some(args=>args.at(-3).includes(`${bunPackage}.zip`)))throw Error('Composed refresh downloaded an already pinned Bun.');
      const probes=requests.filter(args=>args.includes('x-virgo-launcher-refresh: 1')&&args.at(-3).endsWith('/current.json')).length;
      if(probes!==(variant==='bound'?1:2))throw Error(`Wrong future/legacy-bridge probe count: ${variant}/${probes}`);
      if(JSON.parse(await readFile(metadataPath,'utf8')).launcherSha256!==sha(nextBytes))throw Error('Official metadata did not actually move before the bridge.');
      if(rows[0].bridgeKind!==(variant==='bound'?'unchanged':'refreshed'))throw Error(`Bridge did not exercise exact source ownership: ${rows[0].bridgeKind}`);
      if(variant==='bound') {
        await resetRefresh();
        const directArgs=['upgrade','--mode','host','--machine','manual-direct'];
        success(command(process.execPath,[assetPath,...directArgs],{...env,...extra,VIRGO_LAUNCHER_STATE:join(home,'.local/share/virgo/launcher'),VIRGO_LAUNCHER_REFRESH_ONCE:'1'}));
        const direct=await effects();if(direct.length!==1||direct[0].guard!==null||direct[0].bridgeKind!=='unchanged'||JSON.stringify(direct[0].args)!==JSON.stringify(directArgs))throw Error('Bound direct bridge did not preserve one unguarded effect.');
        try {await readFile(downloadLog);throw Error('Bound bytes performed bridge network work.');}catch(error){if(error.code!=='ENOENT')throw error;}
        console.log(JSON.stringify({control:'bound-bytes-direct-manual-guard',networkRequests:0,effects:1,guard:null}));
      }
      console.log(JSON.stringify({control:'future-refresh-moving-metadata',variant,acquisitions:acquisitions.length,effects:rows.length,guard:rows[0].guard}));
      current.launcherSha256=sha(nextBytes);
    }
    // An actual old installer AND old JavaScript produce the pre-S289 public entry.
    const oldInstall=spawnSync('git',['show','1d7ad69:install.sh'],{cwd:repository,encoding:'utf8'}),oldLauncher=spawnSync('git',['show','1d7ad69:launcher.js'],{cwd:repository});
    if(oldInstall.status!==0||oldLauncher.status!==0)throw Error('Pinned historical source is unavailable.');
    const oldInstaller=join(fixtureDir,'old-acquisition.sh');await writeFile(oldInstaller,linux?oldInstall.stdout:oldInstall.stdout.replace(/readonly BUN_ARCHIVE_SHA='[a-f0-9]+'/u,`readonly BUN_ARCHIVE_SHA='${sha(await readFile(zip))}'`).replace(/readonly BUN_SHA='[a-f0-9]+'/u,`readonly BUN_SHA='${sha(await readFile(process.execPath))}'`));
    const legacyHome=join(root,'old official entry home');await mkdir(legacyHome);
    await publish(linux?oldLauncher.stdout:Buffer.from(oldLauncher.stdout.toString().replace(/const BUN_SHA = '[a-f0-9]+';/u,`const BUN_SHA = '${sha(await readFile(process.execPath))}';`)));success(command('/bin/bash',[oldInstaller],{...environment,HOME:legacyHome}));
    await publish(baseLauncher);await resetRefresh();
    const legacyArgs=['install','--mode','host','--machine','legacy','--root',join(root,'legacy requested root'),'--release',current.release,'--github-repository','virgo-codes/virgo-release'];
    success(command(join(legacyHome,'.local/bin/virgo'),legacyArgs,{...environment,HOME:legacyHome,...extra}));
    const oldRows=await effects(),oldRequests=await observed();if(oldRows.length!==1||oldRows[0].guard!==null||oldRows[0].bridgeKind!=='refreshed'||JSON.stringify(oldRows[0].args)!==JSON.stringify(legacyArgs))throw Error('Old-entry bridge did not preserve one same CLI invocation.');
    if(oldRequests.filter(args=>args.at(-3).endsWith('/install.sh')).length!==1||oldRequests.some(args=>args.at(-3).includes(`${bunPackage}.zip`)))throw Error('Old entry failed to acquire exactly once through the pinned-runtime reuse passage.');
    console.log(JSON.stringify({control:'actual-pre-S289-installer-entry-bridge',acquisitions:1,effects:oldRows.length,guard:oldRows[0].guard}));
    await publish(baseLauncher);
  } else console.log('NOT_RUN: paired product-bridge controls require VIRGO_TEST_PRODUCT_REFRESH_HELPER.');
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
