// A local stand-in for the two public APIs the evaluation's scenarios call, so that their latency and outages don't
// decide the runs' outcomes:
//
// - the math.js API v4, as api.mathjs.org serves it: GET /v4/?expr=&precision= answers with the result, as text/html,
//   or status 400 and the error; POST /v4 with { expr, precision } answers with { result, error } as JSON, where expr
//   is an expression or a list of them; without expr, with status 400 and the error as text/html; and with a body
//   that isn't a JSON object or list, with status 400 and Express's error page. Its errors are
//   "Error: " and math.js's message, whatever the error's type. It evaluates them with the pinned mathjs package
// - the Frankfurter API v1: GET /v1/latest?base=&symbols= answers with fixed rates, in Frankfurter's format
//
// Usage: node skill-layouts/server/server.ts --port <port> --log <file>
// It listens on 127.0.0.1, prints "listening on <port>" once it does, and appends each request to the log, as JSONL.
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { evaluate, format } from 'mathjs';

// ---------------------------------------------------------------------------------------------------------------------
// math.js

type Precision = number | undefined;

function formatted(value: unknown, precision: Precision): string {
    return precision === undefined ? format(value) : format(value, { precision });
}

function precisionOf(value: unknown): Precision {
    const number = typeof value === 'string' && value !== '' ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

// api.mathjs.org answers in text/html, though its answers are plain text, and says "Error: " for any of math.js's errors
const HTML = 'text/html; charset=utf-8';

function errorOf(error: unknown): string {
    return `Error: ${ error instanceof Error ? error.message : String(error) }`;
}

function mathjsGet(url: URL, response: ServerResponse): void {
    const expr = url.searchParams.get('expr');
    if (expr === null) {
        return send(response, 400, HTML, 'Error: Required query parameter "expr" missing in url.');
    }
    try {
        send(response, 200, HTML, formatted(evaluate(expr), precisionOf(url.searchParams.get('precision'))));
    }
    catch (error) {
        send(response, 400, HTML, errorOf(error));
    }
}

// what api.mathjs.org's Express app answers a POST it can't parse as a JSON object or list with
const EXPRESS_BAD_REQUEST = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Bad Request</pre>\n</body>\n</html>\n';

/**
 * The POST body as JSON, when it's a JSON object or list sent as JSON; `undefined` for anything else: another content
 * type, a body that isn't JSON, or JSON that's neither an object nor a list.
 */
function jsonBodyOf(body: string, contentType: string): object | undefined {
    if (! /^application\/json\b/i.test(contentType)) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(body);
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}

function mathjsPost(body: string, contentType: string, response: ServerResponse): void {
    const json = (status: number, result: string | string[] | null, error: string | null) =>
        send(response, status, 'application/json; charset=utf-8', JSON.stringify({ result, error }));
    const parsed = jsonBodyOf(body, contentType);
    if (parsed === undefined) {
        return send(response, 400, HTML, EXPRESS_BAD_REQUEST);
    }
    const request = (Array.isArray(parsed) ? {} : parsed) as { expr?: unknown, precision?: unknown };
    if (typeof request.expr !== 'string' && ! Array.isArray(request.expr)) {
        // an empty object or list gets the hint, as on api.mathjs.org; sic: "sent"
        const empty = Object.keys(parsed).length === 0;
        return send(response, 400, HTML, `Error: Required field "expr" missing in JSON body.${ empty ? ' Did you sent a header "content-type: application/json"?' : '' }`);
    }
    const precision = precisionOf(request.precision);
    try {
        if (Array.isArray(request.expr)) {
            const results = evaluate(request.expr.map(String)) as unknown[];
            return json(200, results.map(result => formatted(result, precision)), null);
        }
        json(200, formatted(evaluate(request.expr), precision), null);
    }
    catch (error) {
        json(400, null, errorOf(error));
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Frankfurter

/** Fixed rates, for one euro, on a fixed date, so that every run sees the same ones. */
const DATE = '2026-11-13';
const EUR_RATES: Record<string, number> = { USD: 1.1052, GBP: 0.8721, JPY: 171.35, CHF: 0.9318, PLN: 4.2471 };

function round(value: number): number {
    return Math.round(value * 100_000) / 100_000;
}

function frankfurterLatest(url: URL, response: ServerResponse): void {
    const base = (url.searchParams.get('base') ?? 'EUR').toUpperCase();
    const inEuros: Record<string, number> = { EUR: 1, ...EUR_RATES };
    const symbols = url.searchParams.get('symbols')?.toUpperCase().split(',').filter(Boolean) ?? Object.keys(inEuros).filter(symbol => symbol !== base);
    if (! inEuros[base] || symbols.some(symbol => ! inEuros[symbol])) {
        return send(response, 404, 'application/json', JSON.stringify({ message: 'not found' }));
    }
    const rates = Object.fromEntries(symbols.filter(symbol => symbol !== base).map(symbol => [ symbol, round(inEuros[symbol] / inEuros[base]) ]));
    send(response, 200, 'application/json', JSON.stringify({ amount: 1.0, base, date: DATE, rates }));
}

// ---------------------------------------------------------------------------------------------------------------------

function send(response: ServerResponse, status: number, type: string, body: string): void {
    response.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*' });
    response.end(body);
}

function bodyOf(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', chunk => body += chunk).on('end', () => resolve(body)).on('error', reject);
    });
}

function argument(name: string): string {
    const index = process.argv.indexOf(name);
    if (index === -1 || ! process.argv[index + 1]) {
        throw new Error('usage: server.ts --port <port> --log <file>');
    }
    return process.argv[index + 1];
}

const port = Number(argument('--port'));
const log = argument('--log');

// the harness's probes say so, so the smoke run can tell them from npm test's requests; see PROBE_HEADER in outcome.ts
const PROBE_HEADER = 'x-skill-layouts-probe';

async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    appendFileSync(log, `${ JSON.stringify({ at: new Date().toISOString(), method: request.method, path: request.url, probe: request.headers[PROBE_HEADER] !== undefined }) }\n`);
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/v4' && request.method === 'GET') {
        return mathjsGet(url, response);
    }
    if (path === '/v4' && request.method === 'POST') {
        return mathjsPost(await bodyOf(request), request.headers['content-type'] ?? '', response);
    }
    if (path === '/v1/latest' && request.method === 'GET') {
        return frankfurterLatest(url, response);
    }
    send(response, 404, 'text/plain; charset=utf-8', 'Not Found');
}

const server = createServer((request, response) => {
    // one request the server gets wrong mustn't stop it answering the rest of the run's
    answer(request, response).catch((error: unknown) => {
        console.error(error);
        if (! response.headersSent) {
            send(response, 500, 'text/plain; charset=utf-8', String(error));
        }
        else {
            response.end();
        }
    });
});
server.on('error', error => {
    // e.g. EADDRINUSE, which the harness turns into a message that names the port
    console.error(String(error));
    process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`listening on ${ port }`));
