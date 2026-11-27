// Every child process the harness starts: the commands it runs to completion, such as git, npm and tar; the harness's
// own checks, sandboxed; the agents, in process groups of their own, with their output in files; and the local API
// server, which runs until it's stopped. It wraps Node's execFileSync and spawn rather than reimplementing them, so
// the errors of a command that failed are Node's own, with its status, stdout and stderr.
import { execFileSync, spawn, type StdioOptions } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import type { ChecksSandbox, SandboxPaths } from './sandbox.ts';

export interface RunOptions {
    cwd?: string;
    /** Defaults to process.env, as execFileSync's does */
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    /** Node's stdio; by default, execFileSync's: stdin and stdout piped, and stderr piped and passed on to the harness's */
    stdio?: StdioOptions;
    maxBuffer?: number;
}

const optionsOf = ({ cwd, env, input, stdio, maxBuffer }: RunOptions) => ({
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    ...(input === undefined ? {} : { input }),
    ...(stdio === undefined ? {} : { stdio }),
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
});

/** Runs a command to completion, and returns its stdout; throws Node's error when it fails or can't start. */
export function run(command: string, args: string[], options: RunOptions = {}): string {
    return execFileSync(command, args, { ...optionsOf(options), encoding: 'utf8' });
}

/** Runs a command to completion, and returns its stdout as bytes, such as an archive; throws as `run` does. */
export function runBuffer(command: string, args: string[], options: RunOptions = {}): Buffer {
    return execFileSync(command, args, optionsOf(options));
}

/** A command that couldn't start says nothing about the run's code, so it stops the scoring rather than failing the run. */
export class CommandDidNotStart extends Error {}

export function commandDidNotStart(command: string, reason: string): CommandDidNotStart {
    return new CommandDidNotStart(`couldn't start ${ command }: ${ reason }`);
}

// the errors of a command that couldn't start at all, rather than one that ran and failed
const SPAWN_ERRORS = new Set([ 'ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'ENOTDIR' ]);

/** How a command that ran to completion went. */
export interface Completed {
    /** It exited with a status other than 0, was stopped, or overran its output's buffer */
    failed: boolean;
    /** Its timeout stopped it, or a signal did */
    timedOut: boolean;
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    /** Only what a command that failed printed: a command that succeeded leaves it empty */
    stderr: string;
}

/**
 * Runs a command to completion, optionally in a sandbox, without throwing when it fails. Throws CommandDidNotStart when
 * it couldn't start: a spawn error, such as ENOENT or EACCES, or the sandbox's refusal. stdin is ignored.
 */
export function complete(
    command: string,
    args: string[],
    { cwd, env, timeoutMs, maxBuffer, sandbox }:
        { cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, maxBuffer?: number, sandbox?: { checks: ChecksSandbox, paths: SandboxPaths } },
): Completed {
    const started = sandbox ? sandbox.checks.wrap(command, args, sandbox.paths) : { command, args };
    try {
        const stdout = execFileSync(started.command, started.args, {
            cwd, env, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ], timeout: timeoutMs, ...(maxBuffer === undefined ? {} : { maxBuffer }),
        });
        return { failed: false, timedOut: false, status: 0, signal: null, stdout, stderr: '' };
    }
    catch (error) {
        const { status, signal, stdout = '', stderr = '', code, message } = error as { status: number | null, signal: NodeJS.Signals | null, stdout?: string, stderr?: string, code?: string, message: string };
        // a command killed by its timeout ran, and failed
        if (code === 'ETIMEDOUT' || signal) {
            return { failed: true, timedOut: true, status, signal, stdout, stderr };
        }
        if (code !== undefined && SPAWN_ERRORS.has(code)) {
            throw commandDidNotStart(command, message);
        }
        const refusal = sandbox?.checks.refusalOf(status, stderr);
        if (refusal) {
            throw commandDidNotStart(command, refusal);
        }
        return { failed: true, timedOut: false, status, signal, stdout, stderr };
    }
}

/** How a command spawnWithTimeout ran went. */
export interface Finished {
    exitCode: number;
    durationMs: number;
    /** It didn't finish in time, so its process group was stopped */
    timedOut: boolean;
}

// how long the command gets to stop after SIGTERM, before its process group is killed, and how long its output then
// gets to close, before the harness stops waiting for it
const GRACE_MS = 10_000;

/**
 * Runs a command with its output in files, and stops it when it runs out of time. The command starts a process group
 * of its own, so stopping it stops whatever it started too, such as the test runs and servers of an agent.
 */
export function spawnWithTimeout(
    command: string,
    args: string[],
    { cwd, env, stdout, stderr, timeoutMs, graceMs = GRACE_MS, openOutput = path => createWriteStream(path) }:
        { cwd: string, env: NodeJS.ProcessEnv, stdout: string, stderr: string, timeoutMs: number, graceMs?: number, openOutput?: (path: string) => Writable },
): Promise<Finished> {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, detached: true, stdio: [ 'ignore', 'pipe', 'pipe' ] });
    const outputs = [ child.stdout.pipe(openOutput(stdout)), child.stderr.pipe(openOutput(stderr)) ];

    let timedOut = false;
    const signalGroup = (signal: NodeJS.Signals) => {
        try {
            process.kill(-child.pid!, signal);
        }
        catch {
            // the group has already gone
        }
    };
    let exitCode: number | undefined;
    let kill: NodeJS.Timeout | undefined;
    let abandon: NodeJS.Timeout | undefined;
    // a process that left the group can keep the pipes open for ever, so in the end the harness closes them itself
    const stopWaiting = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        outputs.forEach(output => output.end());
    };
    const timeout = setTimeout(() => {
        timedOut = true;
        signalGroup('SIGTERM');
        kill = setTimeout(() => signalGroup('SIGKILL'), graceMs);
        abandon = setTimeout(stopWaiting, 2 * graceMs);
    }, timeoutMs);

    child.on('exit', code => {
        exitCode = code ?? 1;
        clearTimeout(timeout);
        if (timedOut) {
            // whatever the command started and left behind in its group
            signalGroup('SIGKILL');
            clearTimeout(kill);
        }
    });
    const closed = new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => {
            clearTimeout(abandon);
            resolve(code ?? exitCode ?? 1);
        });
    });

    // the output files are read afterwards, so they have to be complete, not just the command finished
    return Promise.all([ closed, ...outputs.map(output => finished(output)) ])
        .then(([ exitCode ]) => ({ exitCode, durationMs: Date.now() - started, timedOut }));
}

/** A command that runs until it's stopped, such as the local API server. */
export interface Daemon {
    /** Everything it has printed so far, stdout and stderr together, in the order it arrived */
    output(): string;
    /** Calls `listener` with each chunk it prints from now on, and which of its outputs printed it */
    onOutput(listener: (chunk: string, stream: 'stdout' | 'stderr') => void): void;
    /** Resolves with its exit code when it exits */
    readonly exited: Promise<number | null>;
    /** Stops it, and resolves once it has exited */
    stop(): Promise<void>;
}

export function startDaemon(command: string, args: string[]): Daemon {
    const child = spawn(command, args, { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    let output = '';
    const listeners: Array<(chunk: string, stream: 'stdout' | 'stderr') => void> = [];
    for (const stream of [ 'stdout', 'stderr' ] as const) {
        child[stream].on('data', chunk => {
            output += chunk;
            listeners.forEach(listener => listener(String(chunk), stream));
        });
    }
    return {
        output: () => output,
        onOutput: listener => listeners.push(listener),
        exited,
        stop: () => {
            child.kill();
            return exited.then(() => undefined);
        },
    };
}
