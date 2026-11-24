import { request as httpRequest } from 'node:http';
import { Agent } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type ApiServer, ensurePortFree, freePort, serverRequestsOf, startApiServer, withApiServer } from '../src/api-server.ts';
import { unreachable } from '../src/outcome.ts';

/** A request to the local server, with an agent of its own, so a proxy the environment names doesn't get in the way. */
// `body` is sent as JSON, with its content type; `raw`, as it is, with `type`
function call(url: string, { method = 'GET', body, raw, type }: { method?: string, body?: unknown, raw?: string, type?: string } = {}): Promise<{ status: number, type: string, body: string }> {
    const sent = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const contentType = type ?? (body === undefined ? undefined : 'application/json');
    return new Promise((resolve, reject) => {
        const request = httpRequest(url, { method, agent: new Agent(), headers: contentType ? { 'content-type': contentType } : {} }, response => {
            let text = '';
            response.on('data', chunk => text += chunk).on('end', () => resolve({ status: response.statusCode!, type: String(response.headers['content-type']), body: text }));
        });
        request.on('error', reject);
        request.end(sent);
    });
}

describe('the local API server', () => {

    let directory: string;
    let server: ApiServer;

    beforeAll(async () => {
        directory = mkdtempSync(join(tmpdir(), 'skill-layouts-server-'));
        server = await startApiServer({ port: await freePort(), log: join(directory, 'requests.jsonl') });
    });
    afterAll(async () => {
        await server.stop();
        rmSync(directory, { recursive: true, force: true });
    });

    it('listens on 127.0.0.1, on the port the harness picked', () => {
        expect(server.urls.mathjs).toBe(`http://127.0.0.1:${ server.port }/v4/`);
        expect(server.urls.frankfurter).toBe(`http://127.0.0.1:${ server.port }/v1`);
    });

    describe('the math.js API v4', () => {

        it.each([
            [ '2 + 2',                '4' ],
            [ '5 inch to cm',         '12.7 cm' ],
            [ '10 / 4',               '2.5' ],
            [ 'det([[1, 2], [3, 4]])', '-2' ],
            [ '2*(7-3)',              '8' ],
        ])('answers GET ?expr=%s with %s, as text/html, as api.mathjs.org does', async (expression, expected) => {
            const response = await call(`${ server.urls.mathjs }?expr=${ encodeURIComponent(expression) }`);

            expect(response).toMatchObject({ status: 200, body: expected });
            expect(response.type).toBe('text/html; charset=utf-8');
        });

        it('answers GET without the trailing slash, as the template asks for it', async () => {
            expect((await call(`http://127.0.0.1:${ server.port }/v4?expr=${ encodeURIComponent('2 + 2') }`)).body).toBe('4');
        });

        it('rounds a GET to the given number of significant digits', async () => {
            expect((await call(`${ server.urls.mathjs }?expr=${ encodeURIComponent('2/3') }&precision=3`)).body).toBe('0.667');
        });

        it('answers an expression it cannot evaluate with status 400 and "Error: " and the message, as text/html', async () => {
            const response = await call(`${ server.urls.mathjs }?expr=2+%2B`);

            expect(response).toEqual({ status: 400, type: 'text/html; charset=utf-8', body: 'Error: Unexpected end of expression (char 4)' });
        });

        it('says "Error: " for any of math.js\'s errors, whatever its type', async () => {
            const response = await call(`${ server.urls.mathjs }?expr=${ encodeURIComponent('[1, 2][5]') }`);

            // an IndexError, which String() would give as "IndexError: …"
            expect(response).toMatchObject({ status: 400, body: 'Error: Index out of range (5 > 2)' });
        });

        it('answers a GET without expr with status 400 and the error, as text/html', async () => {
            expect(await call(server.urls.mathjs)).toEqual({ status: 400, type: 'text/html; charset=utf-8', body: 'Error: Required query parameter "expr" missing in url.' });
        });

        it.each([
            [ { expr: [ '2 + 2', '5 - 3' ] },                  { result: [ '4', '2' ], error: null } ],
            [ { expr: '2 + 2' },                               { result: '4', error: null } ],
            [ { expr: [ '1 / 3' ], precision: 3 },             { result: [ '0.333' ], error: null } ],
            [ { expr: [ '10 / 2' ], precision: 3 },            { result: [ '5' ], error: null } ],
            [ { expr: [ '2 ^ 64' ], precision: 3 },            { result: [ '1.84e+19' ], error: null } ],
        ])('answers POST %j with %j, as JSON', async (body, expected) => {
            const response = await call(`http://127.0.0.1:${ server.port }/v4`, { method: 'POST', body });

            expect(response.status).toBe(200);
            expect(response.type).toMatch(/^application\/json/);
            expect(JSON.parse(response.body)).toEqual(expected);
        });

        it('answers a POST it cannot evaluate with status 400, no result and the error', async () => {
            const response = await call(server.urls.mathjs, { method: 'POST', body: { expr: '2 +' } });

            expect(response.status).toBe(400);
            expect(response.type).toBe('application/json; charset=utf-8');
            expect(JSON.parse(response.body)).toEqual({ result: null, error: 'Error: Unexpected end of expression (char 4)' });
        });

        // api.mathjs.org's Express app parses JSON objects and lists, and answers anything else with its error page
        const EXPRESS_BAD_REQUEST = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Bad Request</pre>\n</body>\n</html>\n';

        it.each([ [ {} ], [ [] ] ])('answers a POST of %j, an empty JSON object or list, with status 400, and the error with the hint about the content type, as text/html', async body => {
            expect(await call(server.urls.mathjs, { method: 'POST', body })).toEqual({
                status: 400,
                type: 'text/html; charset=utf-8',
                // sic: "sent", as api.mathjs.org says
                body: 'Error: Required field "expr" missing in JSON body. Did you sent a header "content-type: application/json"?',
            });
        });

        it.each([ [ { precision: 3 } ], [ [ '2 + 2' ] ] ])('answers a POST of %j, a JSON object or list without expr, with status 400, and the error without the hint, as text/html', async body => {
            expect(await call(server.urls.mathjs, { method: 'POST', body })).toEqual({
                status: 400,
                type: 'text/html; charset=utf-8',
                body: 'Error: Required field "expr" missing in JSON body.',
            });
        });

        it.each([
            [ 'null',                                   { body: null } ],
            [ 'a number',                               { body: 42 } ],
            [ 'a JSON string',                          { body: '2 + 2' } ],
            [ "a body that isn't JSON",                 { raw: '{"expr": "2 + 2"', type: 'application/json' } ],
            [ 'a form',                                 { raw: 'expr=2%2B2', type: 'application/x-www-form-urlencoded' } ],
        ])("answers a POST of %s, which isn't a JSON object or list, with status 400 and Express's error page, and keeps answering", async (_, request) => {
            expect(await call(server.urls.mathjs, { method: 'POST', ...request })).toEqual({ status: 400, type: 'text/html; charset=utf-8', body: EXPRESS_BAD_REQUEST });
            expect((await call(`${ server.urls.mathjs }?expr=2%2B2`)).body).toBe('4');
        });
    });

    describe('the Frankfurter API v1', () => {

        it("answers the latest rate in Frankfurter's format, with a fixed rate and date", async () => {
            const response = await call(`${ server.urls.frankfurter }/latest?base=EUR&symbols=USD`);

            expect(response.status).toBe(200);
            expect(response.type).toMatch(/^application\/json/);
            expect(JSON.parse(response.body)).toEqual({ amount: 1, base: 'EUR', date: '2026-11-13', rates: { USD: 1.1052 } });
        });

        it('answers every rate it has without symbols, and an unknown currency with 404', async () => {
            expect(Object.keys(JSON.parse((await call(`${ server.urls.frankfurter }/latest?base=EUR`)).body).rates)).toContain('GBP');
            expect((await call(`${ server.urls.frankfurter }/latest?base=EUR&symbols=XXX`)).status).toBe(404);
        });
    });

    it('logs the requests it answers', async () => {
        await call(`${ server.urls.mathjs }?expr=1`);

        expect(server.requests().at(-1)).toMatchObject({ method: 'GET', path: '/v4/?expr=1', probe: false });
    });

    it("logs the harness's probes as probes, so they don't count as npm test's requests", async () => {
        expect(await unreachable([ `${ server.urls.mathjs }?expr=1` ])).toEqual([]);

        expect(server.requests().at(-1)).toMatchObject({ method: 'GET', path: '/v4/?expr=1', probe: true });
    });
});

describe('freePort', () => {
    it('picks a port nothing listens on', async () => {
        expect(await freePort()).toBeGreaterThan(0);
    });
});

describe('a port in use', () => {

    let directory: string;
    let other: Server;
    let port: number;

    beforeEach(async () => {
        directory = mkdtempSync(join(tmpdir(), 'skill-layouts-busy-'));
        port = await freePort();
        other = createServer();
        await new Promise<void>(resolve => other.listen(port, '127.0.0.1', resolve));
    });
    afterEach(async () => {
        await new Promise(resolve => other.close(resolve));
        rmSync(directory, { recursive: true, force: true });
    });

    it("refuses to start the local API server, and says which port is in use", async () => {
        await expect(startApiServer({ port, log: join(directory, 'server.jsonl') }))
            .rejects.toThrow(`port ${ port }, which config.json sets for the local API server, is in use: stop what listens on it, or set another apiServer.port`);
    });

    it('refuses to start the evaluation before preparing anything', async () => {
        await expect(ensurePortFree(port)).rejects.toThrow(`port ${ port }, which config.json sets for the local API server, is in use`);
        await expect(ensurePortFree(await freePort())).resolves.toBeUndefined();
    });
});

describe('withApiServer', () => {

    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'skill-layouts-with-server-'));
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    it('keeps the server running while the run uses it, and stops it afterwards', async () => {
        let url = '';
        const status = await withApiServer(join(directory, 'run', 'server.jsonl'), await freePort(), async server => {
            url = `${ server.urls.mathjs }?expr=1`;
            return (await call(url)).status;
        });

        expect(status).toBe(200);
        await expect(call(url)).rejects.toThrow(/ECONNREFUSED/);
    });

    it('stops the server when the run fails too', async () => {
        let url = '';
        await expect(withApiServer(join(directory, 'server.jsonl'), await freePort(), async server => {
            url = `${ server.urls.mathjs }?expr=1`;
            throw new Error('the run failed');
        })).rejects.toThrow(/the run failed/);

        await expect(call(url)).rejects.toThrow(/ECONNREFUSED/);
    });

    it("starts with an empty log, so a resumed run doesn't count the requests of the attempt before it", async () => {
        const log = join(directory, 'server.jsonl');
        writeFileSync(log, '{"at":"2026-11-13T00:00:00.000Z","method":"GET","path":"/v4/?expr=1"}\n');

        expect(await withApiServer(log, await freePort(), async server => server.requests())).toEqual([]);
    });
});

describe('serverRequestsOf', () => {

    const request = (probe: boolean) => ({ at: '2026-11-13T00:00:00.000Z', method: 'GET', path: '/v4/?expr=1', probe });

    it("tells the agent's requests from those of the harness's checks, which came after the agent finished", () => {
        expect(serverRequestsOf([ request(false), request(false), request(false), request(false), request(false) ], 2)).toEqual({ agent: 2, checks: 3 });
    });

    it("doesn't count the harness's probes as requests of its checks", () => {
        expect(serverRequestsOf([ request(false), request(true) ], 1)).toEqual({ agent: 1, checks: 0 });
    });
});
