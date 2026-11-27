// The harness's side of the local API server: it starts server/server.ts on the port config.json sets, in a process of
// its own, which keeps answering while the harness's own checks block on tsc and npm test, and reads the requests it
// logged. One port for the whole evaluation means every run, and every rescore of it, calls the same URLs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

import { startDaemon } from './child-processes.ts';
import { evalRoot } from './layouts.ts';

export interface ApiServerUrls {
    /** The math.js API's base URL, as the template's test script gives it to the scenarios */
    mathjs: string;
    /** The Frankfurter API's base URL, which request 4's prompt names */
    frankfurter: string;
}

export interface ServerRequest {
    at: string;
    method: string;
    path: string;
    /** It was one of the harness's probes, rather than a request of the agent's or of npm test's */
    probe: boolean;
}

export interface ApiServer {
    port: number;
    urls: ApiServerUrls;
    /** The requests the server answered, from its log */
    requests(): ServerRequest[];
    /** What the server printed, such as the error it stopped with */
    output(): string;
    stop(): Promise<void>;
}

export function urlsOf(port: number): ApiServerUrls {
    return { mathjs: `http://127.0.0.1:${ port }/v4/`, frankfurter: `http://127.0.0.1:${ port }/v1` };
}

/** A port on 127.0.0.1 that nothing listens on. */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as { port: number };
            probe.close(() => resolve(port));
        });
    });
}

function portInUse(port: number): Error {
    return new Error(`port ${ port }, which config.json sets for the local API server, is in use: stop what listens on it, or set another apiServer.port`);
}

/** Refuses a port something already listens on, so the evaluation stops before it prepares anything. */
export function ensurePortFree(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.on('error', error => reject((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? portInUse(port) : error));
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
    });
}

/** Starts the local API server on `port`, logging its requests to `log`, which it empties first, and resolves once it listens. */
export function startApiServer({ port, log }: { port: number, log: string }): Promise<ApiServer> {
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, '');
    const server = startDaemon(process.execPath, [ join(evalRoot, 'server', 'server.ts'), '--port', String(port), '--log', log ]);
    return new Promise((resolve, reject) => {
        server.exited.then(code => reject(server.output().includes('EADDRINUSE')
            ? portInUse(port)
            : new Error(`the local API server didn't start on port ${ port }: it exited with ${ code }${ server.output() ? `: ${ server.output().trim() }` : '' }`)));
        server.onOutput((chunk, stream) => {
            if (stream === 'stdout' && chunk.includes(`listening on ${ port }`)) {
                resolve({
                    port,
                    urls: urlsOf(port),
                    requests: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ServerRequest),
                    output: () => server.output(),
                    stop: () => server.stop(),
                });
            }
        });
    });
}

/** Runs `use` with a local API server on `port`, logging to `log`, and stops the server once `use` settles. */
export async function withApiServer<T>(log: string, port: number, use: (server: ApiServer) => Promise<T>): Promise<T> {
    const server = await startApiServer({ port, log });
    try {
        return await use(server);
    }
    finally {
        await server.stop();
    }
}

/**
 * The requests the server logged while the agent ran, the first `agent` of them, and those of the harness's tsc and
 * npm test after it, leaving out the harness's probes: they reach the server from outside the checks' sandbox.
 */
export function serverRequestsOf(requests: ServerRequest[], agent: number): { agent: number, checks: number } {
    return { agent, checks: requests.slice(agent).filter(request => ! request.probe).length };
}

/**
 * Why a run can't be scored when the local API server didn't answer: the server, not the run's code, failed, so the
 * evaluation stops, with what the server printed and the last requests it logged.
 */
export function localServerDown(runId: string, down: string[], server: Pick<ApiServer, 'requests' | 'output'>): Error {
    const last = server.requests().slice(-10).map(request => `  ${ request.at } ${ request.method } ${ request.path }${ request.probe ? ' (probe)' : '' }`);
    return new Error([
        `run ${ runId }: the local API server didn't answer ${ down.join(', ') }, which is the harness's failure, not the run's.`,
        'Its output:',
        server.output().trim() || '(nothing)',
        'Its last requests:',
        ...(last.length > 0 ? last : [ '  (none)' ]),
    ].join('\n'));
}
