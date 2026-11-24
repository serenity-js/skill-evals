// Whether a run's code works: tsc --noEmit and npm test both pass. When an agent errored or made no tool calls, the
// project is the untouched template, which passes both, so that run is an agent failure, which the correctness rate
// leaves out too. When the APIs the scenarios call are down, npm test
// says nothing about the code, so the run gets an outcome of its own, which the correctness rate leaves out. The log
// can't tell that apart from a host the agent got wrong, or a scenario that fails for a reason of its own, so after a
// failed npm test the harness probes the APIs the run's request needs itself, and while a probe fails, waits and runs
// npm test again. A run is a network failure only when every attempt failed while a probe failed too, and even then not
// for good: once the evaluation's runs are done, and again on --summarise, the harness scores it again, with rescore.

import { Agent as HttpAgent, get as httpGet } from 'node:http';
import { Agent as HttpsAgent, get as httpsGet } from 'node:https';

export type Outcome = 'correct' | 'incorrect' | 'network-failure' | 'agent-failure';

export interface CommandResult {
    exitCode: number;
    /** What the command printed, stdout and stderr together */
    log: string;
    /** It ran under sandbox-exec */
    sandboxed?: boolean;
}

/** The APIs the local server stands in for, which a request's scenarios can call. */
export const APIS = [ 'mathjs', 'frankfurter' ] as const;
export type Api = typeof APIS[number];

/** What the harness requests of the local API server to check that each API is up. */
const PROBES: Record<Api, (urls: { mathjs: string, frankfurter: string }) => string> = {
    mathjs: urls => `${ urls.mathjs }?expr=1`,
    frankfurter: urls => `${ urls.frankfurter }/latest`,
};

/** The probes of the APIs a run's request needs, as `requests.json` lists them, on the run's local API server. */
export function probesFor(apis: Api[], urls: { mathjs: string, frankfurter: string }): string[] {
    return apis.map(api => PROBES[api](urls));
}

/** The header the harness's probes send, so the server's log tells them from the agent's and npm test's requests. */
export const PROBE_HEADER = 'x-skill-layouts-probe';

/** The URLs that get no response within the timeout. Any response, even an error status, means the host is reachable. */
export async function unreachable(urls: string[], timeoutMs = 10_000): Promise<string[]> {
    const reached = await Promise.all(urls.map(url => new Promise<boolean>(resolve => {
        // an agent of its own, so a proxy the environment names doesn't stand between the harness and the local server
        const request = (url.startsWith('https:') ? httpsGet : httpGet)(url, { agent: url.startsWith('https:') ? new HttpsAgent() : new HttpAgent(), timeout: timeoutMs, headers: { [PROBE_HEADER]: '1' } }, response => {
            response.resume();
            resolve(true);
        });
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(false));
    })));
    return urls.filter((_, index) => ! reached[index]);
}

export interface TestAttempts {
    /** The last attempt, which the run is scored on */
    test: CommandResult;
    attempts: number;
    /** Every attempt failed while a probe failed too */
    networkFailure: boolean;
    /** What the last probe couldn't reach */
    unreachable: string[];
}

/** npm test, run again up to `retries` more times, `delayMs` apart, while a probe fails after it fails. */
export async function testWithRetries({ runTest, probe, wait, retries = 2, delayMs = 30_000 }: {
    runTest: () => CommandResult,
    probe: () => Promise<string[]>,
    wait: (ms: number) => Promise<void>,
    retries?: number,
    delayMs?: number,
}): Promise<TestAttempts> {
    for (let attempt = 1; ; attempt++) {
        const test = runTest();
        if (test.exitCode === 0) {
            return { test, attempts: attempt, networkFailure: false, unreachable: [] };
        }
        const down = await probe();
        if (down.length === 0 || attempt > retries) {
            return { test, attempts: attempt, networkFailure: down.length > 0, unreachable: down };
        }
        await wait(delayMs);
    }
}

/**
 * Why the agent didn't do the run's work, or `undefined` when it did: it exited with an error, or made no tool calls.
 * Either way the project is the untouched template, which compiles and passes its tests, so tsc and npm test can't
 * tell the run from a correct one. An agent that the timeout stopped isn't a failure, unless it never called a tool.
 */
export function agentFailureOf({ exitCode, timedOut, completedToolCalls }: { exitCode: number, timedOut: boolean, completedToolCalls: number }): string | undefined {
    if (completedToolCalls === 0) {
        return 'the agent made no tool calls';
    }
    return exitCode !== 0 && ! timedOut ? `the agent exited with ${ exitCode }` : undefined;
}

/**
 * The outcome of a run, given its tsc, the npm test it's scored on, whether every attempt failed with the APIs down,
 * and why the agent failed, if it did, which comes first: the run says nothing about the code or the layout.
 */
export function outcomeOf({ tsc, test, networkFailure, agentFailure }: { tsc: CommandResult, test: CommandResult, networkFailure: boolean, agentFailure?: string }): Outcome {
    if (agentFailure) {
        return 'agent-failure';
    }
    if (tsc.exitCode !== 0) {
        return 'incorrect';
    }
    if (test.exitCode === 0) {
        return 'correct';
    }
    return networkFailure ? 'network-failure' : 'incorrect';
}

export type Rescored =
    | { outcome: 'network-failure', unreachable: string[] }
    | { outcome: Outcome, tsc: CommandResult, test: CommandResult, attempts: number, unreachable: string[] };

/**
 * A network failure, scored again once the evaluation's runs are done: while the APIs are still down, it stays one,
 * without running anything; once they're reachable, tsc and npm test run again, and the run is scored as usual.
 */
export async function rescore({ runTsc, runTest, probe, wait }: {
    runTsc: () => CommandResult,
    runTest: () => CommandResult,
    probe: () => Promise<string[]>,
    wait: (ms: number) => Promise<void>,
}): Promise<Rescored> {
    const down = await probe();
    if (down.length > 0) {
        return { outcome: 'network-failure', unreachable: down };
    }
    const tsc = runTsc();
    const tests = await testWithRetries({ runTest, probe, wait });
    return {
        outcome: outcomeOf({ tsc, test: tests.test, networkFailure: tests.networkFailure }),
        tsc,
        test: tests.test,
        attempts: tests.attempts,
        unreachable: tests.unreachable,
    };
}
