// The sandbox the harness's own checks, tsc and npm test, run in: they run the code an agent wrote, so they shouldn't
// be able to change anything else, read the user's files, or reach any host but localhost. macOS's sandbox-exec is
// the only sandbox so far; another platform's would be another ChecksSandbox, chosen in checksSandboxFor.
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { run } from './child-processes.ts';

/**
 * What the harness's checks may touch: they write only in `writable`, the run's directory and TMPDIR, and read nothing
 * in `home` outside `writable` and `readable`, npm's cache and the Node.js installation.
 */
export interface SandboxPaths {
    writable: string[];
    readable: string[];
    home: string;
}

/** A sandbox for the harness's checks. */
export interface ChecksSandbox {
    /** Why the checks can't run in this sandbox here, such as a platform without it, or none */
    problems(): string[];
    /** The command, to run in the sandbox, with the run's paths */
    wrap(command: string, args: string[], paths: SandboxPaths): { command: string, args: string[] };
    /** Why the sandbox refused to start a command that exited with `status`, from what it printed, or undefined */
    refusalOf(status: number | null, stderr: string): string | undefined;
}

// Seatbelt matches real paths, e.g. /private/var rather than /var, so the paths that exist are resolved
const realPathOf = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);

/**
 * The paths of the checks in `directory`, with the environment they run with: npm's cache is npm_config_cache, or
 * ~/.npm, and Node.js is installed in the prefix of `execPath`, which may be in HOME, as with nvm.
 */
export function sandboxPathsOf(env: NodeJS.ProcessEnv, directory: string, execPath: string = process.execPath): SandboxPaths {
    const home = realPathOf(env.HOME ?? homedir());
    return {
        writable: [ realPathOf(directory), realPathOf(env.TMPDIR ?? tmpdir()) ],
        readable: [ realPathOf(env.npm_config_cache ?? join(home, '.npm')), realPathOf(dirname(dirname(execPath))) ],
        home,
    };
}

/**
 * A macOS sandbox profile that allows everything but: writing outside `writable`, and the null and terminal devices;
 * reading in `home` outside `writable` and `readable`, though a path's metadata can be read, so that a command looked
 * up on a PATH with directories in HOME is still found; and the network, apart from localhost, and the system's DNS
 * resolver, so that `localhost` resolves.
 */
export function sandboxProfile({ writable, readable, home }: SandboxPaths): string {
    for (const path of [ ...writable, ...readable, home ]) {
        if (/["\\()\n]/.test(path)) {
            throw new Error(`${ path } can't be put in a sandbox profile`);
        }
    }
    const subpaths = (paths: string[]) => paths.map(path => `(subpath "${ path }")`).join(' ');
    return [
        '(version 1)',
        '(allow default)',
        '(deny file-write*)',
        `(allow file-write* ${ subpaths(writable) } (literal "/dev/null") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
        `(deny file-read* ${ subpaths([ home ]) })`,
        `(allow file-read-metadata ${ subpaths([ home ]) })`,
        `(allow file-read* ${ subpaths([ ...writable, ...readable ]) })`,
        '(deny network*)',
        '(allow network-outbound (remote ip "localhost:*"))',
        '(allow network-bind network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    ].join('\n');
}

/** macOS's sandbox-exec, which the harness's checks run under */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// sandbox-exec exits with 71 and says why, on standard error, when it can't apply the profile or start the command
const SANDBOX_REFUSAL = /^sandbox-exec: .*$/m;

/** sandbox-exec's start, with the profile the checks get, so a profile it can't apply refuses the runs before they start. */
const startOf = (executable: string) => () => run(executable, [ '-p', sandboxProfile(sandboxPathsOf(process.env, tmpdir())), '/usr/bin/true' ], { stdio: 'pipe' });

/** macOS's sandbox-exec, as a ChecksSandbox: only on macOS, and not inside another sandbox, where it can't start. */
function sandboxExec(platform: NodeJS.Platform, executable: string, start: () => unknown): ChecksSandbox {
    return {
        problems: () => {
            if (platform !== 'darwin') {
                return [ `the harness runs tsc and npm test under sandbox-exec, which ${ platform } doesn't have: pass --unsandboxed to run them without a sandbox` ];
            }
            try {
                start();
                return [];
            }
            catch (error) {
                const { stderr, message } = error as { stderr?: Buffer | string, message: string };
                return [ `the harness runs tsc and npm test under sandbox-exec, which can't start here (${ String(stderr ?? '').trim() || message }): run the evaluation from your own terminal, outside any sandbox, or pass --unsandboxed to run them without one` ];
            }
        },
        wrap: (command, args, paths) => ({ command: executable, args: [ '-p', sandboxProfile(paths), command, ...args ] }),
        refusalOf: (status, stderr) => status === 71 ? SANDBOX_REFUSAL.exec(stderr)?.[0] : undefined,
    };
}

/**
 * The checks' sandbox on `platform`: sandbox-exec, the only one so far, which says on another platform that it's not
 * there. `executable` is another sandbox-exec only in the specs, and `start` how it's tried.
 */
export function checksSandboxFor(
    platform: NodeJS.Platform,
    { executable = SANDBOX_EXEC, start = startOf(executable) }: { executable?: string, start?: () => unknown } = {},
): ChecksSandbox {
    return sandboxExec(platform, executable, start);
}

/** The harness's command, under sandbox-exec, with the profile of the run's paths. */
export function sandboxed(command: string, args: string[], paths: SandboxPaths, executable: string = SANDBOX_EXEC): { command: string, args: string[] } {
    return checksSandboxFor('darwin', { executable }).wrap(command, args, paths);
}

/**
 * Whether the harness can sandbox its checks here: sandbox-exec is macOS's, and can't start inside another sandbox.
 * Without it, the checks only run given --unsandboxed.
 */
export function sandboxProblems(platform: NodeJS.Platform, start?: () => unknown): string[] {
    return checksSandboxFor(platform, start ? { start } : {}).problems();
}

/**
 * How the harness's checks run: under sandbox-exec where it can start, whether or not it's given --unsandboxed; and,
 * where it can't, without a sandbox, given --unsandboxed, or not at all, with what refuses them.
 */
export function checksSandbox(platform: NodeJS.Platform, { unsandboxed, start }: { unsandboxed: boolean, start?: () => unknown }): { problems: string[], checks: { unsandboxed: boolean } } {
    const problems = sandboxProblems(platform, start);
    if (problems.length === 0) {
        return { problems, checks: { unsandboxed: false } };
    }
    return unsandboxed ? { problems: [], checks: { unsandboxed: true } } : { problems, checks: { unsandboxed: false } };
}
