import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, readFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const REPOSITORY = 'virgo-codes/virgo-release';
const CURRENT_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/current.json`;
const BUN_VERSION = '1.3.14';
const BUN_SHA = 'e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233';
const HASH = /^[a-f0-9]{64}$/u;
const stateRoot = process.env.VIRGO_LAUNCHER_STATE ?? join(homedir(), '.local', 'share', 'virgo', 'launcher');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('Malformed installation or release receipt.');

async function run(executable, args) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
      accept(code ?? (signal === 'SIGINT' ? 130 : 143));
    });
  });
}
async function download(url, path) {
  if (await run('curl', ['-q', '--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', url, '--output', path]) !== 0)
    fail('Download failed; the existing command and installation are unchanged. Repeat the same command to retry.');
}
async function regularBytes(path, maximum, privateFile = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum || (privateFile && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())))
      fail('Installed receipt or release file is unsafe. Restore its original verified bytes and permissions, then repeat the command.');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function json(path, maximum = 4 * 1024 * 1024, privateFile = false) { return object(JSON.parse(await regularBytes(path, maximum, privateFile))); }
async function directory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f\u007f]/u.test(path)) fail('Installation directory must be an absolute canonical path.');
  if (dirname(path) !== path) await directory(dirname(path));
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000))) || await realpath(path) !== path)
    fail('Installation directory is unsafe. Use the original canonical installation path.');
}
async function configuredRuntime() {
  const executable = join(homedir(), '.local/share/virgo/bootstrap/bun', BUN_VERSION, 'bin/bun');
  const pin = await json(join(homedir(), '.local/share/virgo/bootstrap/config.json'), 8192, true);
  if (pin.schemaVersion !== 1 || pin.bunVersion !== BUN_VERSION || pin.executable !== executable || pin.sha256 !== BUN_SHA || typeof pin.identity !== 'string')
    fail('Official bootstrap runtime configuration is missing or changed; repeat official acquisition.');
  await directory(dirname(executable));
  const info = await lstat(executable), identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0 || await realpath(executable) !== executable ||
      !/^\d+:\d+:\d+:\d+(?:\.\d+)?$/u.test(pin.identity) || pin.identity.slice(pin.identity.indexOf(':')) !== identity.slice(identity.indexOf(':')) ||
      digest(await regularBytes(executable, 128 * 1024 * 1024)) !== BUN_SHA)
    fail('Configured Bun is missing or mismatched; no runtime fallback is allowed. Repeat official acquisition.');
  return { executable, identity };
}

function metadata(value) {
  if (value.sourceRepository !== 'virgo-codes/virgo' || value.platform?.os !== 'macos' || value.platform?.architecture !== 'arm64' || !HASH.test(value.release) || !HASH.test(value.cliSha256))
    fail('Official current metadata is invalid; repeat after the official selection is repaired.');
  return value;
}
async function currentCLI(suppliedMetadata, operator = false) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(stateRoot, '.download-'));
  try {
    const metadataPath = suppliedMetadata ?? join(scratch, 'current.json');
    if (!suppliedMetadata) await download(CURRENT_URL, metadataPath);
    const current = metadata(await json(metadataPath));
    const pin = operator ? object(current.operator) : current;
    if (!HASH.test(pin.release) || !HASH.test(pin.cliSha256)) fail('Official operator CLI is not pinned; repeat official acquisition after publication.');
    const final = join(stateRoot, 'releases', pin.cliSha256, 'virgo');
    try {
      if (digest(await regularBytes(final, 64 * 1024 * 1024)) === pin.cliSha256) return { path: final, current };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const staged = join(scratch, 'virgo');
    await download(`https://github.com/${REPOSITORY}/releases/download/release-${pin.release}/virgo-macos-arm64`, staged);
    if (digest(await regularBytes(staged, 64 * 1024 * 1024)) !== pin.cliSha256)
      fail('Release CLI checksum failed; the existing command and installation are unchanged. Repeat the same command to retry.');
    await mkdir(dirname(final), { recursive: true, mode: 0o700 });
    await rename(staged, final);
    return { path: final, current };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Read the existing installer receipt and archive; never choose newest for an installed target. */
async function installedCLI(requested) {
  await directory(requested);
  let root = basename(dirname(requested)) === 'instances' ? dirname(dirname(requested)) : requested;
  let selected = requested;
  if (root === requested) {
    // Root selection is useful only for the existing CLI's operator commands.
    const { readdir } = await import('node:fs/promises');
    await directory(join(root, 'instances'));
    const candidates = (await readdir(join(root, 'instances'))).filter(name => name.includes('%00agent_host%00'));
    if (candidates.length !== 1) fail('The root has more than one installation; use its exact instances directory.');
    selected = join(root, 'instances', candidates[0]);
  }
  await directory(root); await directory(selected);
  const state = await json(join(selected, 'installation-state.json'), 4 * 1024 * 1024, true);
  const config = await json(join(selected, 'virgo.config.json'), 4 * 1024 * 1024, true);
  const target = object(state.target), active = object(state.active), verified = object(active.artifact), artifact = object(verified.artifact);
  if (state.schemaVersion !== 1 || config.schemaVersion !== 1 || typeof target.machine !== 'string' || typeof target.instance !== 'string' || target.component !== 'agent_host' ||
      typeof state.installedRelease !== 'string' || state.installedRelease !== config.release || config.machine !== target.machine ||
      artifact.release !== state.installedRelease || artifact.component !== target.component || artifact.format !== 'native_archive' || !HASH.test(artifact.digest) ||
      artifact.platform?.os !== 'macos' || artifact.platform?.architecture !== 'arm64' ||
      selected !== join(root, 'instances', encodeURIComponent(`${target.machine}\0agent_host\0${target.instance}`)) ||
      active.releaseDirectory !== join(root, 'releases', `${state.installedRelease}-${artifact.digest}`))
    fail('Installation receipt and selected release differ. Resume the existing installation plan before retrying.');
  const release = await verifiedReleaseCLI(active.releaseDirectory, verified.handle, artifact.digest, state.installedRelease);
  return { ...release, root, directory: selected, target, config, state };
}
async function verifiedReleaseCLI(releaseDirectory, handle, archiveDigest, release) {
  await directory(releaseDirectory);
  if (typeof handle !== 'string' || !isAbsolute(handle) || await realpath(handle) !== handle)
    fail('The verified installation archive is unavailable; restore the original cached distribution and retry.');
  const archiveBytes = await regularBytes(handle, 384 * 1024 * 1024);
  if (digest(archiveBytes) !== archiveDigest) fail('Installed distribution checksum failed; restore the original cached distribution and retry.');
  const archive = object(JSON.parse(archiveBytes));
  if (archive.schemaVersion !== 1 || archive.release !== release || archive.component !== 'agent_host' ||
      archive.platform?.os !== 'macos' || archive.platform?.architecture !== 'arm64' || !Array.isArray(archive.entries))
    fail('Installed archive identity does not match the receipt.');
  const entry = name => {
    const matches = archive.entries.filter(item => item.path === name && item.kind === 'file');
    if (matches.length !== 1 || !HASH.test(matches[0].digest) || typeof matches[0].content !== 'string' || digest(Buffer.from(matches[0].content, 'base64')) !== matches[0].digest)
      fail('Installed archive does not contain its verified CLI and descriptor.');
    return matches[0];
  };
  const cli = join(releaseDirectory, 'bin', 'virgo');
  for (const name of ['bin/virgo', 'release.json']) {
    const pin = entry(name), path = join(releaseDirectory, name);
    if (await realpath(path) !== path || digest(await regularBytes(path, 64 * 1024 * 1024)) !== pin.digest)
      fail('Installed CLI or descriptor checksum failed; restore the original release and retry.');
  }
  const descriptor = await json(join(releaseDirectory, 'release.json'));
  if (descriptor.release !== release) fail('Installed descriptor names a different release.');
  return { path: cli, descriptor, digest: entry('bin/virgo').digest };
}
/** Verify the existing registration, then use only the official configured runtime. */
async function installedExecutable(selected, migration = false, planId) {
  const registration = join(selected.root, 'processes', 'supervision', 'registration');
  await directory(registration);
  let pending;
  try { pending = await json(join(registration, 'runtime-transition.json'), 8192, true); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (pending) {
    if (Object.keys(pending).length !== 1 || !HASH.test(pending.planId)) fail('Interpreter transition marker is invalid; preserve its original plan before recovery.');
    if (!migration || planId !== pending.planId)
      fail(`Interpreter migration is pending; resume virgo --directory ${JSON.stringify(selected.directory)} host runtime apply --plan-id ${pending.planId} before other commands.`);
  }
  const receipt = await json(join(registration, 'supervisor.json'), 1024 * 1024, true);
  const verify = async pin => {
    if (pin.schemaVersion !== 1 || pin.root !== selected.root || pin.launchAgentsDirectory !== join(homedir(), 'Library', 'LaunchAgents') ||
        pin.intervalSeconds !== 5 || typeof pin.releaseDirectory !== 'string' || typeof pin.executable !== 'string' ||
        typeof pin.executableIdentity !== 'string' || !/^\d+:\d+:\d+:\d+(?:\.\d+)?$/u.test(pin.executableIdentity))
      fail('Installed supervisor registration is invalid; restore its original receipt before retrying.');
    const parts = basename(pin.releaseDirectory).split('-');
    if (parts.length !== 2 || !parts.every(part => HASH.test(part)) || pin.releaseDirectory !== join(selected.root, 'releases', `${parts[0]}-${parts[1]}`))
      fail('Supervisor release is outside the selected installation.');
    const slots = [selected.state.active, selected.state.previous];
    const retained = slots.find(slot => slot?.releaseDirectory === pin.releaseDirectory && slot.artifact?.artifact?.digest === parts[1]);
    const cli = await verifiedReleaseCLI(pin.releaseDirectory, retained?.artifact?.handle ?? join(selected.root, 'cache', parts[1]), parts[1], parts[0]);
    if (pin.cli !== cli.path || pin.cliDigest !== cli.digest || cli.descriptor.daemonSupervision?.protocolVersion !== 1 ||
        cli.descriptor.daemonSupervision?.cliExecutable !== 'bin/virgo')
      fail('Supervisor CLI differs from its verified release.');
    // The historical interpreter is inspected, never executed by migration.
    // Retain the product's canonical path/file identity fence; Homebrew's owned
    // Cellar ancestor may be group-writable. Configured Bun has stricter custody.
    for (let at = dirname(pin.executable); at !== dirname(at); at = dirname(at)) {
      const parent = await lstat(at);
      if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(at) !== at) fail('Historical interpreter path changed.');
    }
    const info = await lstat(pin.executable);
    const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    if (!info.isFile() || info.isSymbolicLink() || await realpath(pin.executable) !== pin.executable ||
        ![0, process.getuid()].includes(info.uid) || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0 ||
        pin.executableIdentity.slice(pin.executableIdentity.indexOf(':')) !== identity.slice(identity.indexOf(':')))
      fail('Recorded supervisor executable changed; restore the original verified executable before retrying.');
  };
  await verify(receipt);
  // A retained replacement is product-owned recovery, not authority to choose another runtime.
  let replacement;
  try { replacement = await json(join(registration, 'replacement.json'), 1024 * 1024, true); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (replacement) {
    if (replacement.schemaVersion !== 1 || Object.keys(replacement).length !== 3 ||
        ![replacement.before, replacement.after].some(pin => JSON.stringify(pin) === JSON.stringify(receipt)) ||
        JSON.stringify({ ...replacement.before, releaseDirectory: replacement.after.releaseDirectory, cli: replacement.after.cli, cliDigest: replacement.after.cliDigest }) !== JSON.stringify(replacement.after))
      fail('Supervisor replacement differs from the retained registration.');
    await verify(replacement.before); await verify(replacement.after);
  }
  const runtime = await configuredRuntime();
  if (!migration && (receipt.executable !== runtime.executable || receipt.executableIdentity.slice(receipt.executableIdentity.indexOf(':')) !== runtime.identity.slice(runtime.identity.indexOf(':'))))
    fail('Supervisor uses a different runtime; use the supported host runtime prepare/apply transition before lifecycle operations.');
  return runtime.executable;
}

function parseOptions(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!/^--[a-z][a-z0-9-]*$/u.test(key ?? '') || !value || value.startsWith('--') || /[\u0000-\u001f\u007f]/u.test(value) || flags.has(key))
      fail('Options must be unique --name value pairs.');
    flags.set(key, value);
  }
  if (flags.has('--root') && !isAbsolute(flags.get('--root'))) fail('--root must be absolute.');
  return flags;
}
function rootCommandArgs(argv, selected) {
  if (argv[0] === 'skill') {
    if (argv[1] === 'install') {
      const rootIndex = argv.indexOf('--root');
      const root = rootIndex === -1 ? join(homedir(), 'virgo') : argv[rootIndex + 1];
      if (!root || !isAbsolute(root) || resolve(root) !== selected.root)
        fail('Skill installation root differs from --directory; pass --root for the selected installation.');
    }
    return argv;
  }
  const flags = parseOptions(argv.slice(1));
  const mode = flags.get('--mode');
  const installedMode = ['host', 'remote_host'].includes(selected.config.mode) ? 'host' : 'local';
  const root = resolve(flags.get('--root') ?? join(homedir(), 'virgo'));
  const instance = flags.get('--instance') ?? (mode === 'host' ? 'host' : 'local-hub');
  if (mode !== installedMode || root !== selected.root || flags.get('--machine') !== selected.target.machine || instance !== selected.target.instance)
    fail('Setup mode/root/machine/instance differs from --directory; use the selected installation target.');
  return argv;
}
async function main(argv) {
  if (argv[0] === '--bootstrap-cache' && argv.length === 2) { await currentCLI(argv[1]); const current = await json(argv[1]); if (current.operator) await currentCLI(argv[1], true); return 0; }
  await configuredRuntime();
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
    console.log('Usage: virgo install|upgrade --mode local|host --machine ID [--root ABS] [options]\n       virgo rollback --mode local|host --machine ID --plan-id ID [options]\n       virgo --directory ABS <installed command>\nInstall and upgrade select the verified official current release unless an exact release and distribution are supplied.');
    return 0;
  }
  if (argv[0] === '--directory') {
    if (!argv[1] || !isAbsolute(argv[1])) fail('--directory requires an absolute installation path.');
    const selected = await installedCLI(argv[1]);
    const command = argv.slice(2);
    const migration = command[0] === 'host' && command[1] === 'runtime';
    if (migration && !((command.length === 3 && command[2] === 'prepare') || (command.length === 5 && command[2] === 'apply' && command[3] === '--plan-id' && HASH.test(command[4])))) fail('Use host runtime prepare or host runtime apply --plan-id <returned ID>.');
    const rootCommand = ['skill', 'knowledge-setup', 'capability-setup'].includes(command[0]);
    const args = rootCommand ? rootCommandArgs(command, selected) : argv;
    const executable = await installedExecutable(selected, migration, migration && command[2] === 'apply' ? command[4] : undefined);
    const cli = migration ? (await currentCLI(undefined, true)).path : selected.path;
    return run(executable, [cli, ...args]);
  }
  if (!['install', 'upgrade', 'rollback'].includes(argv[0])) fail('Use --directory ABS for an installed command.');
  const flags = parseOptions(argv.slice(1));
  if (!flags.get('--machine')) fail('--machine is required.');
  let mode = flags.get('--mode') ?? (argv[0] === 'install' ? 'local' : undefined);
  if (!['local', 'host'].includes(mode)) fail('--mode local or --mode host is required for upgrade and rollback.');
  const args = [...argv];
  if (!flags.has('--mode')) args.push('--mode', mode);
  const distributions = ['--github-repository', '--manifest-directory', '--bundle'].filter(flag => flags.has(flag));
  if (argv[0] === 'rollback') {
    if (!flags.get('--plan-id')) fail('Rollback requires --plan-id from the retained plan.');
    if (flags.has('--release') || (mode === 'host' && distributions.length)) fail('Host rollback uses its retained plan and cached distribution; omit release/distribution flags.');
    if (mode === 'local' && (distributions.length !== 1 || flags.has('--bundle'))) fail('Local rollback requires its retained --github-repository or --manifest-directory.');
    const root = resolve(flags.get('--root') ?? join(homedir(), 'virgo'));
    const instance = flags.get('--instance') ?? (mode === 'host' ? 'host' : 'local-hub');
    const directory = join(root, 'instances', encodeURIComponent(`${flags.get('--machine')}\0agent_host\0${instance}`));
    const selected = await installedCLI(directory);
    return run(await installedExecutable(selected), [selected.path, ...args]);
  }
  if (flags.has('--plan-id')) fail('--plan-id is only supported for rollback.');
  if ((flags.has('--release') || distributions.length) && (!flags.has('--release') || distributions.length !== 1))
    fail('Exact release selection requires --release and exactly one distribution option.');
  const root = resolve(flags.get('--root') ?? join(homedir(), 'virgo'));
  const instance = flags.get('--instance') ?? (mode === 'host' ? 'host' : 'local-hub');
  const targetDirectory = join(root, 'instances', encodeURIComponent(`${flags.get('--machine')}\0agent_host\0${instance}`));
  let executable = (await configuredRuntime()).executable;
  try {
    await lstat(targetDirectory);
    const installed = await installedCLI(targetDirectory);
    const installedMode = ['host', 'remote_host'].includes(installed.config.mode) ? 'host' : 'local';
    if (installedMode !== mode) fail('Mode differs from the selected installation.');
    executable = await installedExecutable(installed);
  } catch (error) {
    // Only an absent target is a clean install; missing receipts inside one never fall back.
    if (error.code !== 'ENOENT' || await lstat(targetDirectory).then(() => true, missing => missing.code === 'ENOENT' ? false : Promise.reject(missing))) throw error;
  }
  const selected = await currentCLI(undefined, true);
  if (!flags.has('--release')) args.push('--release', selected.current.release, '--github-repository', REPOSITORY);
  return run(executable, [selected.path, ...args]);
}
try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(`virgo: ${error.message ?? 'Command failed; retry using the preserved installation.'}`); process.exitCode = 1; }
