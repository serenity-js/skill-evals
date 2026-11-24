import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentFailureOf, outcomeOf, probesFor, rescore, testWithRetries } from '../src/outcome.ts';

describe('outcomeOf', () => {

    const passed = { exitCode: 0, log: '' };
    const failed = (log: string) => ({ exitCode: 1, log });

    it('is correct when tsc --noEmit and npm test both pass', () => {
        expect(outcomeOf({ tsc: passed, test: passed, networkFailure: false })).toBe('correct');
    });

    it('is incorrect when either fails for a reason of its own', () => {
        expect(outcomeOf({ tsc: { exitCode: 2, log: 'error TS2322' }, test: passed, networkFailure: false })).toBe('incorrect');
        expect(outcomeOf({ tsc: passed, test: failed('AssertionError: Expected the rate to be greater than 0'), networkFailure: false })).toBe('incorrect');
    });

    it('is a network failure when every attempt at npm test failed while the APIs were unreachable', () => {
        expect(outcomeOf({ tsc: passed, test: failed('Error: getaddrinfo ENOTFOUND api.mathjs.org'), networkFailure: true })).toBe('network-failure');
    });

    it('is incorrect when npm test fails while the APIs are reachable, as with a host the agent got wrong', () => {
        expect(outcomeOf({ tsc: passed, test: failed('Error: getaddrinfo ENOTFOUND api.frankfurter.app'), networkFailure: false })).toBe('incorrect');
    });

    it("is an agent failure when the agent errored or made no tool calls, however the untouched template's tsc and npm test do", () => {
        expect(outcomeOf({ tsc: passed, test: passed, networkFailure: false, agentFailure: 'the agent made no tool calls' })).toBe('agent-failure');
        expect(outcomeOf({ tsc: { exitCode: 2, log: '' }, test: failed('x'), networkFailure: true, agentFailure: 'the agent exited with 1' })).toBe('agent-failure');
    });

    it('is incorrect when tsc fails, whatever happens to npm test', () => {
        expect(outcomeOf({ tsc: { exitCode: 2, log: 'error TS2322' }, test: failed('Error: getaddrinfo ENOTFOUND api.mathjs.org'), networkFailure: true })).toBe('incorrect');
    });
});

describe('agentFailureOf', () => {

    it('is none when the agent exited with 0 after completing tool calls', () => {
        expect(agentFailureOf({ exitCode: 0, timedOut: false, completedToolCalls: 4 })).toBeUndefined();
    });

    it('is none when the agent was stopped by the timeout after completing tool calls, which the run scores as far as it goes', () => {
        expect(agentFailureOf({ exitCode: 1, timedOut: true, completedToolCalls: 4 })).toBeUndefined();
    });

    it('says the agent exited with an error, naming the exit code', () => {
        expect(agentFailureOf({ exitCode: 1, timedOut: false, completedToolCalls: 4 })).toMatch(/exited with 1/);
    });

    it('says the agent made no tool calls, as when it refused to start, even when it exited with 0 or ran out of time', () => {
        expect(agentFailureOf({ exitCode: 0, timedOut: false, completedToolCalls: 0 })).toMatch(/no tool calls/);
        expect(agentFailureOf({ exitCode: 1, timedOut: true, completedToolCalls: 0 })).toMatch(/no tool calls/);
    });
});

describe('testWithRetries', () => {

    const passed = { exitCode: 0, log: 'passing' };
    const failed = { exitCode: 1, log: 'Error: getaddrinfo ENOTFOUND api.mathjs.org' };
    const down = [ 'https://api.mathjs.org/v4/?expr=1' ];

    /** npm test and the probes, answering in turn, and what the harness asked for */
    function harness(tests: Array<typeof passed>, probes: string[][]) {
        const calls: string[] = [];
        return {
            calls,
            options: {
                runTest: () => { calls.push('test'); return tests.shift()!; },
                probe: async () => { calls.push('probe'); return probes.shift()!; },
                wait: async () => { calls.push('wait'); },
            },
        };
    }

    it('runs npm test once when it passes', async () => {
        const { calls, options } = harness([ passed ], []);

        expect(await testWithRetries(options)).toMatchObject({ test: passed, networkFailure: false, attempts: 1 });
        expect(calls).toEqual([ 'test' ]);
    });

    it("doesn't retry a failure while the APIs are reachable, which is the code's", async () => {
        const { calls, options } = harness([ failed ], [ [] ]);

        expect(await testWithRetries(options)).toMatchObject({ test: failed, networkFailure: false, attempts: 1 });
        expect(calls).toEqual([ 'test', 'probe' ]);
    });

    it('waits and runs npm test again while a probe fails, and scores the attempt that passes', async () => {
        const { calls, options } = harness([ failed, passed ], [ down ]);

        expect(await testWithRetries(options)).toMatchObject({ test: passed, networkFailure: false, attempts: 2 });
        expect(calls).toEqual([ 'test', 'probe', 'wait', 'test' ]);
    });

    it('is a network failure only when all three attempts failed while a probe failed too', async () => {
        const { calls, options } = harness([ failed, failed, failed ], [ down, down, down ]);

        expect(await testWithRetries(options)).toMatchObject({ test: failed, networkFailure: true, attempts: 3, unreachable: down });
        expect(calls).toEqual([ 'test', 'probe', 'wait', 'test', 'probe', 'wait', 'test', 'probe' ]);
    });

    it('scores the last attempt as usual when the APIs come back but npm test still fails', async () => {
        const assertion = { exitCode: 1, log: 'AssertionError: Expected 4' };
        const { options } = harness([ failed, assertion ], [ down, [] ]);

        expect(await testWithRetries(options)).toMatchObject({ test: assertion, networkFailure: false, attempts: 2 });
    });
});

describe('probesFor', () => {

    const urls = { mathjs: 'http://127.0.0.1:4567/v4/', frankfurter: 'http://127.0.0.1:4567/v1' };

    it("probes the local API server, for only the APIs the run's request needs", () => {
        expect(probesFor([ 'mathjs' ], urls)).toEqual([ 'http://127.0.0.1:4567/v4/?expr=1' ]);
        expect(probesFor([ 'mathjs', 'frankfurter' ], urls)).toEqual([ 'http://127.0.0.1:4567/v4/?expr=1', 'http://127.0.0.1:4567/v1/latest' ]);
    });

    it("doesn't let a Frankfurter outage make a failure of request 1, which only calls math.js, a network failure", async () => {
        const frankfurterDown = async (urls: string[]) => urls.filter(url => url.includes('frankfurter'));
        const failed = { exitCode: 1, log: 'AssertionError: Expected 12.7 cm' };

        const attempts = await testWithRetries({
            runTest: () => failed,
            probe: () => frankfurterDown(probesFor([ 'mathjs' ], urls)),
            wait: async () => {},
        });

        expect(attempts).toMatchObject({ networkFailure: false, attempts: 1 });
        expect(outcomeOf({ tsc: { exitCode: 0, log: '' }, test: attempts.test, networkFailure: attempts.networkFailure })).toBe('incorrect');
    });
});

describe('rescore', () => {

    const passed = { exitCode: 0, log: 'passing' };
    const failed = { exitCode: 1, log: 'Error: getaddrinfo ENOTFOUND api.mathjs.org' };
    const down = [ 'https://api.mathjs.org/v4/?expr=1' ];

    it('scores a run on the rerun, once the APIs that were down during the run are reachable again', async () => {
        expect(await rescore({ runTsc: () => passed, runTest: () => passed, probe: async () => [], wait: async () => {} })).toEqual({
            outcome: 'correct', tsc: passed, test: passed, attempts: 1, unreachable: [],
        });
    });

    it('scores the rerun as incorrect when the APIs are back but the tests still fail', async () => {
        const assertion = { exitCode: 1, log: 'AssertionError: Expected 4' };

        expect((await rescore({ runTsc: () => passed, runTest: () => assertion, probe: async () => [], wait: async () => {} })).outcome).toBe('incorrect');
    });

    it("keeps a run a network failure while the APIs are still down, without running anything", async () => {
        const calls: string[] = [];
        const result = await rescore({
            runTsc: () => { calls.push('tsc'); return passed; },
            runTest: () => { calls.push('test'); return failed; },
            probe: async () => down,
            wait: async () => {},
        });

        expect(result).toEqual({ outcome: 'network-failure', unreachable: down });
        expect(calls).toEqual([]);
    });
});

describe('unreachable', () => {

    let server: Server;
    let reachable: string;

    beforeAll(async () => {
        server = createServer((_, response) => { response.statusCode = 404; response.end(); });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        reachable = `http://127.0.0.1:${ (server.address() as AddressInfo).port }/v4/?expr=1`;
    });
    afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

    /**
     * Calls unreachable in a Node process of its own, which reaches 127.0.0.1 directly even in a sandbox that makes
     * Node's fetch use a proxy: Node only reads NO_PROXY when it starts.
     */
    async function unreachable(urls: string[]): Promise<string[]> {
        const module = pathToFileURL(join(import.meta.dirname, '..', 'src', 'outcome.ts')).href;
        const { stdout } = await promisify(execFile)(process.execPath, [
            '--input-type=module', '--eval', `import { unreachable } from '${ module }'; console.log(JSON.stringify(await unreachable(${ JSON.stringify(urls) }, 2000)))`,
        ], { env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } });
        return JSON.parse(stdout) as string[];
    }

    it('lists the URLs that get no response, and counts any response, even an error status, as reached', async () => {
        const closed = 'http://127.0.0.1:9/latest';

        expect(await unreachable([ reachable, closed ])).toEqual([ closed ]);
    });
});
