import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, readFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const REPOSITORY = 'virgo-codes/virgo-release';
const CURRENT_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/current.json`;
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
function metadata(value) {
  if (value.sourceRepository !== 'virgo-codes/virgo' || value.platform?.os !== 'macos' || value.platform?.architecture !== 'arm64' || !HASH.test(value.release) || !HASH.test(value.cliSha256))
    fail('Official current metadata is invalid; repeat after the official selection is repaired.');
  return value;
}
async function currentCLI(suppliedMetadata) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(stateRoot, '.download-'));
  try {
    const metadataPath = suppliedMetadata ?? join(scratch, 'current.json');
    if (!suppliedMetadata) await download(CURRENT_URL, metadataPath);
    const current = metadata(await json(metadataPath));
    const final = join(stateRoot, 'releases', current.cliSha256, 'virgo');
    try {
      if (digest(await regularBytes(final, 64 * 1024 * 1024)) === current.cliSha256) return { path: final, current };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const staged = join(scratch, 'virgo');
    await download(`https://github.com/${REPOSITORY}/releases/download/release-${current.release}/virgo-macos-arm64`, staged);
    if (digest(await regularBytes(staged, 64 * 1024 * 1024)) !== current.cliSha256)
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
  await directory(active.releaseDirectory);
  if (typeof verified.handle !== 'string' || !isAbsolute(verified.handle) || await realpath(verified.handle) !== verified.handle)
    fail('The verified installation archive is unavailable; restore the original cached distribution and retry.');
  const archiveBytes = await regularBytes(verified.handle, 384 * 1024 * 1024);
  if (digest(archiveBytes) !== artifact.digest) fail('Installed distribution checksum failed; restore the original cached distribution and retry.');
  const archive = object(JSON.parse(archiveBytes));
  if (archive.schemaVersion !== 1 || archive.release !== state.installedRelease || archive.component !== target.component ||
      archive.platform?.os !== artifact.platform.os || archive.platform?.architecture !== artifact.platform.architecture || !Array.isArray(archive.entries))
    fail('Installed archive identity does not match the receipt.');
  const entry = name => {
    const matches = archive.entries.filter(item => item.path === name && item.kind === 'file');
    if (matches.length !== 1 || !HASH.test(matches[0].digest) || typeof matches[0].content !== 'string' || digest(Buffer.from(matches[0].content, 'base64')) !== matches[0].digest)
      fail('Installed archive does not contain its verified CLI and descriptor.');
    return matches[0];
  };
  const cli = join(active.releaseDirectory, 'bin', 'virgo');
  for (const name of ['bin/virgo', 'release.json']) {
    const pin = entry(name), path = join(active.releaseDirectory, name);
    if (await realpath(path) !== path || digest(await regularBytes(path, 64 * 1024 * 1024)) !== pin.digest)
      fail('Installed CLI or descriptor checksum failed; restore the original release and retry.');
  }
  const descriptor = await json(join(active.releaseDirectory, 'release.json'));
  if (descriptor.release !== state.installedRelease) fail('Installed descriptor names a different release.');
  return { path: cli, root, directory: selected, target, config };
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
  if (argv[0] === '--bootstrap-cache' && argv.length === 2) { await currentCLI(argv[1]); return 0; }
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
    console.log('Usage: virgo install|upgrade --mode local|host --machine ID [--root ABS] [options]\n       virgo rollback --mode local|host --machine ID --plan-id ID [options]\n       virgo --directory ABS <installed command>\nInstall and upgrade select the verified official current release unless an exact release and distribution are supplied.');
    return 0;
  }
  if (argv[0] === '--directory') {
    if (!argv[1] || !isAbsolute(argv[1])) fail('--directory requires an absolute installation path.');
    const selected = await installedCLI(argv[1]);
    const command = argv.slice(2);
    const rootCommand = ['skill', 'knowledge-setup', 'capability-setup'].includes(command[0]);
    const args = rootCommand ? rootCommandArgs(command, selected) : argv;
    return run(process.execPath, [selected.path, ...args]);
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
    return run(process.execPath, [(await installedCLI(directory)).path, ...args]);
  }
  if (flags.has('--plan-id')) fail('--plan-id is only supported for rollback.');
  if ((flags.has('--release') || distributions.length) && (!flags.has('--release') || distributions.length !== 1))
    fail('Exact release selection requires --release and exactly one distribution option.');
  const selected = await currentCLI();
  if (!flags.has('--release')) args.push('--release', selected.current.release, '--github-repository', REPOSITORY);
  return run(process.execPath, [selected.path, ...args]);
}
try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(`virgo: ${error.message ?? 'Command failed; retry using the preserved installation.'}`); process.exitCode = 1; }
