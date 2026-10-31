import { constants as refreshConstants } from 'node:fs';
import { open as refreshOpen, lstat as refreshStat, realpath as refreshRealpath, mkdtemp as refreshTemp, rm as refreshRemove } from 'node:fs/promises';
import { join as refreshJoin, dirname as refreshDirname, resolve as refreshResolve, isAbsolute as refreshAbsolute } from 'node:path';
import { homedir as refreshHome } from 'node:os';
import { createHash as refreshHash } from 'node:crypto';
const LAUNCHER_REFRESH_TIMEOUT_MS = 10_000;
const LAUNCHER_REFRESH_ONCE = 'VIRGO_LAUNCHER_REFRESH_ONCE';
const LAUNCHER_REFRESH_PENDING = 'virgo: launcher refresh pending; the verified command will continue.';
// Bind ONLY after Web reviews the exact self-refresh-capable launcher source.
const refreshCleanupMs = 1_000;
const refreshBase = 'https://raw.githubusercontent.com/virgo-codes/virgo-release/main/';
const refreshDigest = (bytes) => refreshHash('sha256').update(bytes).digest('hex');
async function refreshDirectory(path) {
    if (!refreshAbsolute(path) || refreshResolve(path) !== path || /[\u0000-\u001f\u007f]/u.test(path))
        throw new Error();
    if (refreshDirname(path) !== path)
        await refreshDirectory(refreshDirname(path));
    const info = await refreshStat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await refreshRealpath(path) !== path || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000))))
        throw new Error();
}
async function refreshBytes(path, maximum = 64 * 1024, privateFile = false) {
    const file = await refreshOpen(path, refreshConstants.O_RDONLY | refreshConstants.O_NOFOLLOW | refreshConstants.O_NONBLOCK);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & (privateFile ? 0o077 : 0o022)) !== 0 || info.size > maximum)
            throw new Error();
        return await file.readFile();
    }
    finally {
        await file.close();
    }
}
// Decode ONLY the literal word grammar emitted by Bash printf %q. Never eval/source a wrapper.
function refreshLiteral(word) {
    if (word.startsWith("$'") && word.endsWith("'")) {
        const bytes = [];
        const text = word.slice(2, -1);
        for (let i = 0; i < text.length; i++) {
            if (text[i] !== "\\") {
                if (text[i] === "'")
                    throw new Error();
                const cp = text.codePointAt(i);
                bytes.push(Buffer.from(String.fromCodePoint(cp)));
                if (cp > 0xffff)
                    i++;
                continue;
            }
            const next = text[++i];
            if (next === undefined)
                throw new Error();
            const simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\x0b', "\\": "\\", "'": "'" };
            if (next in simple) {
                bytes.push(Buffer.from(simple[next]));
                continue;
            }
            const tail = text.slice(i);
            const oct = /^[0-7]{1,3}/u.exec(tail);
            if (oct) {
                bytes.push(Buffer.from([Number.parseInt(oct[0], 8)]));
                i += oct[0].length - 1;
                continue;
            }
            const hex = /^(?:x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/u.exec(tail);
            if (!hex)
                throw new Error();
            const cp = Number.parseInt(hex[0].slice(1), 16);
            bytes.push(next === 'x' ? Buffer.from([cp]) : Buffer.from(String.fromCodePoint(cp)));
            i += hex[0].length - 1;
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes));
    }
    let out = '';
    for (let i = 0; i < word.length; i++) {
        const c = word[i];
        if (c === '\\') {
            if (++i === word.length)
                throw new Error();
            out += word[i];
        }
        else {
            if (/[\s$`'";&|<>()]/u.test(c))
                throw new Error();
            out += c;
        }
    }
    return out;
}
async function refreshDefaultEntry(runtimeSha) {
    try {
        const home = refreshHome(), state = refreshJoin(home, '.local/share/virgo/launcher'), entry = refreshJoin(home, '.local/bin/virgo');
        if (process.env.VIRGO_LAUNCHER_STATE !== state)
            return undefined;
        await refreshDirectory(state);
        await refreshDirectory(refreshDirname(entry));
        const entryInfo = await refreshStat(entry);
        if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || entryInfo.nlink !== 1 || (entryInfo.mode & 0o111) === 0)
            return undefined;
        const raw = (await refreshBytes(entry)).toString('utf8');
        const lines = raw.trimEnd().split('\n');
        if (lines[0] !== '#!/usr/bin/env bash' || lines[1] !== 'set -euo pipefail' || !lines[2]?.startsWith('package=') || !lines[3]?.startsWith('state_root=') || !lines[4]?.startsWith('bootstrap_bun='))
            return undefined;
        const packagePath = refreshLiteral(lines[2].slice(8)), shellState = refreshLiteral(lines[3].slice(11)), runtime = refreshLiteral(lines[4].slice(14));
        if (shellState !== state || refreshDirname(packagePath) !== refreshJoin(state, 'packages') || !/^package-[A-Za-z0-9_-]+$/u.test(packagePath.slice(packagePath.lastIndexOf('/') + 1)) || runtime !== refreshJoin(home, '.local/share/virgo/bootstrap/bun/1.3.14/bin/bun'))
            return undefined;
        const tail = lines.slice(5).map(line => line.trim()).filter(Boolean);
        const hashCommand = process.platform === 'linux' ? 'sha256sum "$1" | awk \'{print $1}\'' : 'shasum -a 256 "$1" | awk \'{print $1}\'';
        if (tail.length !== 9 || tail[0] !== 'hash_file ()' || tail[1] !== '{' || tail[2] !== hashCommand || tail[3] !== '}' || tail[4] !== '[[ ! -L "$bootstrap_bun" ]] || { echo "virgo: configured runtime is a symlink." >&2; exit 1; }' || tail[7] !== 'export VIRGO_LAUNCHER_STATE="$state_root"' || tail[8] !== 'exec "$bootstrap_bun" "$package/launcher.js" "$@"')
            return undefined;
        const runtimeMatch = /^\[\[ "\$\(hash_file "\$bootstrap_bun"\)" == ([a-f0-9]{64}) \]\] \|\| \{ echo "virgo: internal runtime checksum failed; repeat official acquisition\." >&2; exit 1; \}$/u.exec(tail[5]);
        const launcherMatch = /^\[\[ "\$\(hash_file "\$package\/launcher\.js"\)" == ([a-f0-9]{64}) \]\] \|\| \{ echo "virgo: launcher checksum failed; repeat official acquisition\." >&2; exit 1; \}$/u.exec(tail[6]);
        if (!runtimeMatch || !launcherMatch)
            return undefined;
        const expected = runtimeSha ?? (process.platform === 'linux' ? '9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74' : 'e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233');
        if (runtimeMatch[1] !== expected)
            return undefined;
        await refreshDirectory(packagePath);
        await refreshDirectory(refreshDirname(runtime));
        const pin = JSON.parse((await refreshBytes(refreshJoin(home, '.local/share/virgo/bootstrap/config.json'), 8192, true)).toString('utf8'));
        const info = await refreshStat(runtime), identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0 || await refreshRealpath(runtime) !== runtime || pin.schemaVersion !== 1 || pin.bunVersion !== '1.3.14' || pin.executable !== runtime || pin.sha256 !== expected || typeof pin.identity !== 'string' || !/^\d+:\d+:\d+:\d+(?:\.\d+)?$/u.test(pin.identity) || pin.identity.slice(pin.identity.indexOf(':')) !== identity.slice(identity.indexOf(':')) || refreshDigest(await refreshBytes(runtime, 128 * 1024 * 1024)) !== expected)
            return undefined;
        const sha = refreshDigest(await refreshBytes(refreshJoin(packagePath, 'launcher.js'), 4 * 1024 * 1024));
        if (sha !== launcherMatch[1])
            return undefined;
        return { entry, state, sha, module: refreshJoin(packagePath, 'launcher.js') };
    }
    catch {
        return undefined;
    }
}
async function refreshDrain(stream) { const reader = stream.getReader(); try {
    while (!(await reader.read()).done) { /* Discard output; never relay environment or acquisition reasons. */ }
}
finally {
    reader.releaseLock();
} }
async function refreshGroup(pid, deadline) {
    const left = deadline - performance.now();
    if (left <= 0)
        return undefined;
    let child;
    try {
        child = Bun.spawn(['/bin/ps', '-axo', 'pid=,pgid=,stat='], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    }
    catch {
        return undefined;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, left));
    try {
        const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text(), refreshDrain(child.stderr)]);
        if (code !== 0)
            return undefined;
        return text.split('\n').some(line => { const fields = line.trim().split(/\s+/u); return Number(fields[1]) === pid && !fields[2]?.startsWith('Z'); });
    }
    catch {
        return undefined;
    }
    finally {
        clearTimeout(timer);
    }
}
async function refreshRun(argv, context) {
    if (performance.now() >= context.workEnd || context.interrupted !== undefined) {
        context.timedOut = true;
        return false;
    }
    const env = { ...process.env };
    delete env[LAUNCHER_REFRESH_ONCE];
    delete env.BASH_ENV;
    delete env.ENV;
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    let child;
    try {
        child = Bun.spawn(argv, { detached: true, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env });
    }
    catch {
        return false;
    }
    const group = child.pid;
    let stopped = false;
    let escalation;
    const kill = (signal) => { try {
        process.kill(-group, signal);
    }
    catch { /* Group may already be gone. */ } };
    const stop = () => { if (!stopped) {
        stopped = true;
        kill('SIGTERM');
        escalation = setTimeout(() => kill('SIGKILL'), Math.max(0, Math.min(refreshCleanupMs / 2, context.deadline - performance.now() - refreshCleanupMs / 2)));
    } };
    const cancel = (code) => { context.interrupted = code; stop(); };
    const onInt = () => cancel(130), onTerm = () => cancel(143), onHup = () => cancel(129);
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    const soft = setTimeout(() => { context.timedOut = true; stop(); }, Math.max(0, context.workEnd - performance.now()));
    // Within the final1s: TERM first, KILL by9.5s, retain0.5s for absence/readback+joins.
    const hard = setTimeout(() => kill('SIGKILL'), Math.max(0, context.deadline - performance.now() - refreshCleanupMs / 2));
    const stdout = refreshDrain(child.stdout), stderr = refreshDrain(child.stderr);
    try {
        const code = await child.exited;
        // Keep both deadline timers live until descendants are proved gone, even if the shell exited.
        let alive = await refreshGroup(group, context.deadline);
        if (alive) {
            stop();
            const escalate = Math.min(context.deadline - refreshCleanupMs / 2, performance.now() + refreshCleanupMs / 2);
            while (alive && performance.now() < context.deadline) {
                if (performance.now() >= escalate)
                    kill('SIGKILL');
                await new Promise(resolve => setTimeout(resolve, 10));
                alive = await refreshGroup(group, context.deadline);
            }
        }
        if (alive !== false) {
            context.unsafe = true;
            kill('SIGKILL');
        }
        await Promise.all([stdout, stderr]);
        return code === 0 && !stopped && !context.timedOut && context.interrupted === undefined && !context.unsafe;
    }
    catch {
        kill('SIGKILL');
        await child.exited.catch(() => { });
        await Promise.allSettled([stdout, stderr]);
        if (await refreshGroup(group, context.deadline) !== false)
            context.unsafe = true;
        return false;
    }
    finally {
        clearTimeout(soft);
        clearTimeout(hard);
        if (escalation)
            clearTimeout(escalation);
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
        process.off('SIGHUP', onHup);
    }
}
async function refreshOfficialLauncher(mode, qualifiedSha = '', runtimeSha, activeModule) {
    delete process.env[LAUNCHER_REFRESH_ONCE];
    const started = performance.now();
    const owned = await refreshDefaultEntry(runtimeSha);
    if (!owned)
        return { kind: 'skipped' };
    // Accepted exact source BYTES own optional refresh; this never claims a probe ran.
    // Only the bridge is redundant. All ordinary command trust/pin checks still run.
    if (mode === 'bridge' && owned.sha === qualifiedSha)
        return { kind: 'unchanged' };
    if (mode === 'launcher' && activeModule) {
        try {
            await refreshDirectory(refreshDirname(activeModule));
            if (refreshDirname(refreshDirname(activeModule)) !== refreshJoin(owned.state, 'packages') || await refreshRealpath(activeModule) !== activeModule)
                return { kind: 'skipped' };
        }
        catch {
            return { kind: 'skipped' };
        }
    }
    const context = { deadline: started + LAUNCHER_REFRESH_TIMEOUT_MS, workEnd: started + LAUNCHER_REFRESH_TIMEOUT_MS - refreshCleanupMs, timedOut: false, unsafe: false };
    let scratch, pending = false;
    try {
        scratch = await refreshTemp(refreshJoin(owned.state, '.refresh-'));
        const metadata = refreshJoin(scratch, 'current.json');
        const curl = (url, path) => ['curl', '-q', '--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--header', 'x-virgo-launcher-refresh: 1', url, '--output', path];
        if (!await refreshRun(curl(refreshBase + 'current.json', metadata), context))
            throw new Error();
        const current = JSON.parse((await refreshBytes(metadata, 4 * 1024 * 1024)).toString('utf8'));
        if (current.sourceRepository !== 'virgo-codes/virgo' || typeof current.launcherSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(current.launcherSha256))
            throw new Error();
        if (owned.sha === current.launcherSha256) {
            if (mode === 'launcher' && activeModule && refreshDigest(await refreshBytes(activeModule, 4 * 1024 * 1024)) !== owned.sha)
                return { kind: 'refreshed', entry: owned.entry };
            return { kind: 'unchanged' };
        }
        const script = refreshJoin(scratch, 'install.sh');
        if (!await refreshRun(curl(refreshBase + 'install.sh', script), context) || !await refreshRun(['/bin/bash', script], context))
            throw new Error();
        const after = await refreshDefaultEntry(runtimeSha);
        if (!after || after.sha !== current.launcherSha256)
            throw new Error();
        return { kind: 'refreshed', entry: after.entry };
    }
    catch {
        if (context.unsafe)
            return { kind: 'unsafe', exitCode: 1 };
        if (context.interrupted !== undefined)
            return { kind: 'cancelled', exitCode: context.interrupted };
        pending = true;
        return { kind: 'pending' };
    }
    finally {
        if (scratch && !context.unsafe)
            try {
                await refreshRemove(scratch, { recursive: true, force: true });
            }
            catch {
                // The owned writer is proved absent. Scratch housekeeping cannot replace
                // the chosen dispatch/cancellation outcome; retain the leftover privately.
                if (!pending && context.interrupted === undefined)
                    console.error(LAUNCHER_REFRESH_PENDING);
            }
    }
}

import { createHash } from 'node:crypto';
import { fileURLToPath as launcherFilePath } from 'node:url';
import { constants } from 'node:fs';
import { open, lstat, realpath, readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const REPOSITORY = 'virgo-codes/virgo-release';
const CURRENT_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/current.json`;
const BUN_VERSION = '1.3.14';
const BUN_SHA = 'e0c90ec15d33363e6b70713d56bc3b2c7585c17f40a0fe0f8fd9305901d4e233';
const PLATFORM = process.platform === 'darwin' && process.arch === 'arm64' ? { os: 'macos', architecture: 'arm64' }
  : process.platform === 'linux' && process.arch === 'x64' ? { os: 'linux', architecture: 'x64' } : undefined;
const RUNTIME_SHA = process.platform === 'linux' ? '9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74' : BUN_SHA;
const matchesPlatform = platform => PLATFORM && platform?.os === PLATFORM.os && platform?.architecture === PLATFORM.architecture;
const HASH = /^[a-f0-9]{64}$/u;
const stateRoot = process.env.VIRGO_LAUNCHER_STATE ?? join(homedir(), '.local', 'share', 'virgo', 'launcher');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('Malformed installation or release receipt.');

async function run(executable, args, env = process.env) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', env });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM'), hangup = () => forward('SIGHUP');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate); process.on('SIGHUP', hangup);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.off('SIGHUP', hangup);
      accept(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143));
    });
  });
}
async function download(url, path, headers = []) {
  if (await run('curl', ['-q', '--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', ...headers.flatMap(header => ['--header', header]), url, '--output', path]) !== 0)
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
  if (!PLATFORM || pin.schemaVersion !== 1 || pin.bunVersion !== BUN_VERSION || pin.executable !== executable || pin.sha256 !== RUNTIME_SHA || typeof pin.identity !== 'string')
    fail('Official bootstrap runtime configuration is missing or changed; repeat official acquisition.');
  await directory(dirname(executable));
  const info = await lstat(executable), identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0 || await realpath(executable) !== executable ||
      !/^\d+:\d+:\d+:\d+(?:\.\d+)?$/u.test(pin.identity) || pin.identity.slice(pin.identity.indexOf(':')) !== identity.slice(identity.indexOf(':')) ||
      digest(await regularBytes(executable, 128 * 1024 * 1024)) !== RUNTIME_SHA)
    fail('Configured Bun is missing or mismatched; no runtime fallback is allowed. Repeat official acquisition.');
  return { executable, identity };
}

function metadata(value) {
  const selected = Array.isArray(value.platforms) ? value.platforms.filter(entry => matchesPlatform(entry?.platform)) : [value];
  if (value.sourceRepository !== 'virgo-codes/virgo' || selected.length !== 1 || !matchesPlatform(selected[0]?.platform) || !HASH.test(selected[0].release) || !HASH.test(selected[0].cliSha256))
    fail('Official current metadata is invalid; repeat after the official selection is repaired.');
  return { ...value, ...selected[0] };
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
    await download(`https://github.com/${REPOSITORY}/releases/download/release-${pin.release}/virgo-${PLATFORM.os}-${PLATFORM.architecture}`, staged);
    if (digest(await regularBytes(staged, 64 * 1024 * 1024)) !== pin.cliSha256)
      fail('Release CLI checksum failed; the existing command and installation are unchanged. Repeat the same command to retry.');
    await mkdir(dirname(final), { recursive: true, mode: 0o700 });
    await rename(staged, final);
    return { path: final, current };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// An explicit official GitHub release runs only its own CLI, fetched and verified
// as virgo's GitHub distribution does (distribution/github-release.ts and
// local-distribution.ts). Unavailable targets fall through; unverified bytes never run.
const MAX_API_BYTES = 2 * 1024 * 1024, MAX_MANIFEST_BYTES = 1024 * 1024, MAX_ARCHIVE_BYTES = 384 * 1024 * 1024;
const INTEGRITY_ATTEMPTS = 3, INTEGRITY_BACKOFF_MS = 1000;
class TargetFailure extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
const unavailable = message => { throw new TargetFailure('unavailable', message); };
const integrity = message => { throw new TargetFailure('integrity', message); };
const releaseName = value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
const manifestDigest = ({ release, artifacts, compatibility }) => digest(canonical({ release, artifacts, ...(compatibility === undefined ? {} : { compatibility }) }));
async function apiBytes(url, path, accept, maximum, missing) {
  try { await download(url, path, [`accept: ${accept}`, 'user-agent: virgo-release-installer', 'x-github-api-version: 2022-11-28']); }
  catch { unavailable(missing); }
  const info = await lstat(path).catch(() => unavailable(missing));
  if (!info.isFile() || info.size > maximum) integrity('GitHub Release response exceeds its size limit.');
  return readFile(path);
}
async function verifiedTarget(release, scratch) {
  const tag = `release-${release}`, api = `https://api.github.com/repos/${REPOSITORY}/releases`;
  if (!releaseName(release) || !releaseName(tag)) integrity('GitHub repository, release, or tag is unsafe.');
  const browser = name => new URL(`https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`).href;
  const parse = (bytes, message) => { try { return JSON.parse(bytes); } catch { return integrity(message); } };
  const metadata = parse(await apiBytes(`${api}/tags/${encodeURIComponent(tag)}`, join(scratch, 'metadata.json'), 'application/vnd.github+json', MAX_API_BYTES,
    'GitHub Release metadata is unavailable.'), 'GitHub Release metadata is malformed.');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) integrity('GitHub Release metadata is malformed.');
  if (metadata.tag_name !== tag || metadata.draft === true || !Array.isArray(metadata.assets)) integrity('GitHub Release metadata does not match the selected tag.');
  const names = new Set();
  for (const asset of metadata.assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset) || !Number.isSafeInteger(asset.id) || asset.id < 1 || typeof asset.name !== 'string' ||
        !releaseName(asset.name) || !Number.isSafeInteger(asset.size) || asset.size < 0)
      integrity('GitHub Release asset metadata is malformed.');
    if (names.has(asset.name)) integrity('GitHub Release contains duplicate asset names.');
    names.add(asset.name);
  }
  const exactAsset = async (name, maximum) => {
    const selected = metadata.assets.find(asset => asset.name === name) ?? unavailable(`GitHub Release is missing required asset ${name}.`);
    if (selected.size > maximum) integrity(`GitHub Release asset ${name} exceeds its size limit.`);
    return apiBytes(`${api}/assets/${selected.id}`, join(scratch, `asset-${selected.id}`), 'application/octet-stream', maximum, 'GitHub Release asset is unavailable.');
  };
  const manifest = parse(await exactAsset(`${release}.json`, MAX_MANIFEST_BYTES), 'GitHub Release manifest is malformed.');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || typeof manifest.release !== 'string' || !HASH.test(String(manifest.manifestDigest)) || !Array.isArray(manifest.artifacts))
    integrity('Release manifest is malformed.');
  for (const artifact of manifest.artifacts) {
    if (!artifact || typeof artifact !== 'object' || !['hub', 'agent_host', 'native_runtime', 'cli', 'mcp', 'hooks'].includes(String(artifact.component)) || artifact.release !== manifest.release ||
        !artifact.platform || !['linux', 'macos'].includes(String(artifact.platform.os)) || !['arm64', 'x64'].includes(String(artifact.platform.architecture)) || !HASH.test(String(artifact.digest)))
      integrity('Release artifact identity is malformed.');
    if (!(artifact.format === 'oci_image' && typeof artifact.source === 'string') &&
        !(artifact.format === 'native_archive' && ['local', 'https'].includes(artifact.source?.kind)))
      integrity('Release artifact format or source is unsupported.');
  }
  if (manifest.compatibility !== undefined && (!manifest.compatibility || typeof manifest.compatibility !== 'object' || Array.isArray(manifest.compatibility)))
    integrity('Release compatibility metadata is malformed.');
  if (manifestDigest(manifest) !== manifest.manifestDigest) integrity('Release manifest digest failed.');
  if (manifest.release !== release) integrity('GitHub Release manifest names a different release.');
  const artifacts = manifest.artifacts.filter(artifact => matchesPlatform(artifact.platform));
  if (artifacts.length === 0) unavailable('GitHub Release has no artifact for this platform.');
  const hosts = artifacts.filter(artifact => artifact.component === 'agent_host' && artifact.format === 'native_archive');
  if (hosts.length !== 1) integrity('Release manifest must contain exactly one agent_host native archive for this platform.');
  const [artifact] = hosts;
  const href = (() => { try { return artifact.source.kind === 'https' ? new URL(String(artifact.source.url)).href : undefined; } catch { return undefined; } })();
  const name = [`${release}.vra`, `${release}-${PLATFORM.os}-${PLATFORM.architecture}.vra`].find(candidate => href === browser(candidate));
  if (name === undefined) integrity('GitHub Release manifest points outside its pinned archive asset.');
  const archiveBytes = await exactAsset(name, MAX_ARCHIVE_BYTES);
  if (digest(archiveBytes) !== artifact.digest) integrity('GitHub Release archive hash differs from its manifest.');
  // Archive, CLI and descriptor identity exactly as verifiedReleaseCLI checks an installed release.
  const archive = parse(archiveBytes, 'Release archive identity does not match the manifest.');
  if (!archive || typeof archive !== 'object' || archive.schemaVersion !== 1 || archive.release !== release || archive.component !== 'agent_host' ||
      !matchesPlatform(archive.platform) || !Array.isArray(archive.entries))
    integrity('Release archive identity does not match the manifest.');
  const entry = path => {
    const matches = archive.entries.filter(item => item?.path === path && item.kind === 'file');
    const bytes = matches.length === 1 && typeof matches[0].content === 'string' ? Buffer.from(matches[0].content, 'base64') : undefined;
    if (!bytes || !HASH.test(String(matches[0].digest)) || digest(bytes) !== matches[0].digest) integrity('Release archive does not contain its verified CLI and descriptor.');
    return { bytes, digest: matches[0].digest };
  };
  const cli = entry('bin/virgo');
  if (parse(entry('release.json').bytes, 'Release descriptor is malformed.')?.release !== release) integrity('Release descriptor names a different release.');
  return cli;
}
/** Returns R's cached verified CLI path, or why it is unavailable or failed integrity. */
async function targetCLI(release) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  let integrityCause;
  for (let attempt = 1; ; attempt++) {
    const scratch = await mkdtemp(join(stateRoot, '.target-'));
    try {
      const cli = await verifiedTarget(release, scratch);
      const final = join(stateRoot, 'releases', cli.digest, 'virgo');
      try {
        if (digest(await regularBytes(final, 64 * 1024 * 1024)) === cli.digest) return { path: final };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const staged = join(scratch, 'virgo');
      await writeFile(staged, cli.bytes, { mode: 0o600 });
      await mkdir(dirname(final), { recursive: true, mode: 0o700 });
      await rename(staged, final);
      return { path: final };
    } catch (error) {
      if (!(error instanceof TargetFailure)) throw error;
      // A fetch failure before any integrity failure keeps today's path, unretried.
      if (error.kind === 'unavailable' && integrityCause === undefined) return { unavailable: error.message };
      if (error.kind === 'integrity') integrityCause = error.message;
      if (attempt >= INTEGRITY_ATTEMPTS) return { integrity: integrityCause, attempts: attempt };
      const delay = INTEGRITY_BACKOFF_MS * 2 ** (attempt - 1);
      console.error(error.kind === 'integrity'
        ? `virgo: target integrity check failed: ${error.message} The artifact was discarded and not run; re-fetching in ${delay / 1000}s.`
        : `virgo: target re-fetch was not available: ${error.message} Re-fetching in ${delay / 1000}s.`);
      await new Promise(accept => setTimeout(accept, delay));
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
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
      !matchesPlatform(artifact.platform) ||
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
      !matchesPlatform(archive.platform) || !Array.isArray(archive.entries))
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
    if (pin.schemaVersion !== 1 || pin.root !== selected.root || pin.launchAgentsDirectory !== (PLATFORM.os === 'linux' ? join(homedir(), '.config', 'systemd', 'user') : join(homedir(), 'Library', 'LaunchAgents')) ||
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
  const capturedArgv = [...argv];
  const refreshedOnce = process.env[LAUNCHER_REFRESH_ONCE] === '1';
  delete process.env[LAUNCHER_REFRESH_ONCE];
  if (argv[0] === '--bootstrap-cache' && argv.length === 2) { const { current } = await currentCLI(argv[1]); if (current.operator) await currentCLI(argv[1], true); return 0; }
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
    const executable = await installedExecutable(selected);
    if (!refreshedOnce) {
      const refresh = await refreshOfficialLauncher('launcher', '', RUNTIME_SHA, launcherFilePath(import.meta.url));
      if (refresh.kind === 'unsafe') throw new Error('Launcher refresh writer cleanup could not be proved.');
      if (refresh.kind === 'cancelled') return refresh.exitCode ?? 1;
      if (refresh.kind === 'pending') console.error(LAUNCHER_REFRESH_PENDING);
      if (refresh.kind === 'refreshed') return run(refresh.entry, capturedArgv, { ...process.env, [LAUNCHER_REFRESH_ONCE]: '1' });
    }
    return run(executable, [selected.path, ...args]);
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
  if (!refreshedOnce) {
    const refresh = await refreshOfficialLauncher('launcher', '', RUNTIME_SHA, launcherFilePath(import.meta.url));
    if (refresh.kind === 'unsafe') throw new Error('Launcher refresh writer cleanup could not be proved.');
    if (refresh.kind === 'cancelled') return refresh.exitCode ?? 1;
    if (refresh.kind === 'pending') console.error(LAUNCHER_REFRESH_PENDING);
    if (refresh.kind === 'refreshed') return run(refresh.entry, capturedArgv, { ...process.env, [LAUNCHER_REFRESH_ONCE]: '1' });
  }
  if (flags.has('--release') && flags.get('--github-repository') === REPOSITORY) {
    const target = await targetCLI(flags.get('--release'));
    if (target.path) return run(executable, [target.path, ...args]);
    if (target.integrity) {
      console.error(`virgo: installed version kept, still working; integrity failed: ${target.integrity.replace(/\.$/u, '')}; the next upgrade run will retry`);
      return 75;
    }
    console.error(`virgo: target unavailable: ${target.unavailable} Continuing with the official operator.`);
  }
  const selected = await currentCLI(undefined, true);
  if (!flags.has('--release')) args.push('--release', selected.current.release, '--github-repository', REPOSITORY);
  return run(executable, [selected.path, ...args]);
}
try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(`virgo: ${error.message ?? 'Command failed; retry using the preserved installation.'}`); process.exitCode = 1; }
