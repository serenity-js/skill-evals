// Compares the local API server with the public APIs it stands in for: status, content type and body, for the
// requests the template's scenarios and the evaluation's requests make, and for errors.
//
// Usage: node skill-layouts/server/compare.ts
// Run it from your own terminal, where api.mathjs.org and api.frankfurter.dev are reachable.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort, startApiServer } from '../src/api-server.ts';

interface Case {
    method: 'GET' | 'POST';
    path: string;
    /** Sent as JSON, with its content type */
    body?: unknown;
    /** Sent as it is, with its own content type, for bodies that aren't JSON */
    raw?: { body: string, type: string };
}

const get = (expression: string, precision?: number): Case =>
    ({ method: 'GET', path: `/v4/?expr=${ encodeURIComponent(expression) }${ precision ? `&precision=${ precision }` : '' }` });
const post = (body: unknown): Case => ({ method: 'POST', path: '/v4', body });
const postRaw = (body: string, type: string): Case => ({ method: 'POST', path: '/v4', raw: { body, type } });

const MATHJS: Case[] = [
    get('2 + 2'), get('5 - 3'), get('5 inch to cm'), get('10 / 4'), get('3 * 3'), get('det([[1, 2], [3, 4]])'),
    get('1 / 3', 3), get('10 / 2', 3), get('2 ^ 64', 3), get('1 + 1'), get('2 +'), { method: 'GET', path: '/v4/' },
    // errors: a syntax error as a form would encode it, and an error of another type than SyntaxError
    { method: 'GET', path: '/v4/?expr=2+%2B' }, get('[1, 2][5]'),
    post({ expr: [ '2 + 2', '5 - 3' ] }), post({ expr: [ '1 / 3' ], precision: 3 }), post({ expr: [ '10 / 4', '3 * 3' ] }),
    post({ expr: '2 + 2' }), post({ expr: '2 +' }), post({ expr: '[1, 2][5]' }),
    // without expr, or with a body that isn't a JSON object
    post({}), post({ precision: 3 }), post(null), post(42), post('2 + 2'), post([ '2 + 2' ]), post([]),
    postRaw('{"expr": "2 + 2"', 'application/json'), postRaw('expr=2%2B2', 'application/x-www-form-urlencoded'),
];
const FRANKFURTER: Case[] = [ { method: 'GET', path: '/v1/latest?base=EUR&symbols=USD' } ];

async function answer(base: string, { method, path, body, raw }: Case) {
    const sent = raw ?? (body === undefined ? undefined : { body: JSON.stringify(body), type: 'application/json' });
    const response = await fetch(`${ base }${ path }`, {
        method,
        headers: sent ? { 'content-type': sent.type } : {},
        body: sent?.body,
    });
    return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() };
}

const directory = mkdtempSync(join(tmpdir(), 'skill-layouts-compare-'));
const server = await startApiServer({ port: await freePort(), log: join(directory, 'requests.jsonl') });
let differences = 0;
try {
    const local = `http://127.0.0.1:${ server.port }`;
    for (const [ remote, cases ] of [ [ 'https://api.mathjs.org', MATHJS ], [ 'https://api.frankfurter.dev', FRANKFURTER ] ] as const) {
        for (const each of cases) {
            const [ theirs, ours ] = await Promise.all([ answer(remote, each), answer(local, each) ]);
            // Frankfurter's rates change daily; the local server's are fixed, so only the shape is compared
            const same = remote.includes('frankfurter')
                ? theirs.status === ours.status && Object.keys(JSON.parse(theirs.body)).join() === Object.keys(JSON.parse(ours.body)).join()
                : JSON.stringify(theirs) === JSON.stringify(ours);
            differences += same ? 0 : 1;
            console.log(`${ same ? 'same     ' : 'DIFFERENT' } ${ each.method } ${ each.path }${ each.raw ? ` ${ JSON.stringify(each.raw.body) } as ${ each.raw.type }` : (each.body !== undefined ? ` ${ JSON.stringify(each.body) }` : '') }`);
            if (! same) {
                console.log(`  ${ remote }: ${ JSON.stringify(theirs) }\n  local:   ${ JSON.stringify(ours) }`);
            }
        }
    }
}
finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
}
process.exitCode = differences > 0 ? 1 : 0;
