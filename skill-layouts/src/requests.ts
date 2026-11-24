// The requests the agents get, one per run, and which building blocks each needs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BUILDING_BLOCKS, type BuildingBlock, evalRoot } from './layouts.ts';
import { type Api, APIS } from './outcome.ts';

export interface Request {
    id: string;
    /** The kind of request it is, as the evaluation's brief lists them */
    kind: string;
    /** What the agent is asked, as a consumer would ask it */
    prompt: string;
    /** The building blocks the request needs, decided before any results; none for the control */
    needs: BuildingBlock[];
    /** A directory in `fixtures/` copied over the project before the run, for requests about existing code */
    fixture?: string;
    /** The APIs the request's scenarios call, which the harness probes on the local API server when npm test fails */
    apis: Api[];
}

export interface Requests {
    requests: Request[];
    /** Run only once a layout has been chosen, to check it wasn't tuned to the other requests */
    heldBack: Request[];
}

export function parseRequests(json: string): Requests {
    const parsed = JSON.parse(json) as Requests;
    const all = [ ...parsed.requests, ...parsed.heldBack ];
    const ids = new Set<string>();
    for (const request of all) {
        if (! request.id || ! request.prompt || ! Array.isArray(request.needs)) {
            throw new Error(`request ${ JSON.stringify(request.id) } needs an id, a prompt and a list of the building blocks it needs`);
        }
        if (ids.has(request.id)) {
            throw new Error(`there are two requests with the id ${ request.id }`);
        }
        ids.add(request.id);
        const unserved = (request.apis ?? []).filter(api => ! (APIS as readonly string[]).includes(api));
        if (! Array.isArray(request.apis) || request.apis.length === 0 || unserved.length > 0) {
            throw new Error(`request ${ request.id } needs apis, the APIs its scenarios call, and lists ${ unserved.join(', ') || 'none' }, which the local API server doesn't serve: ${ APIS.join(', ') }`);
        }
        const unknown = request.needs.filter(block => ! (BUILDING_BLOCKS as readonly string[]).includes(block));
        if (unknown.length > 0) {
            throw new Error(`request ${ request.id } needs ${ unknown.join(', ') }, which aren't building blocks: ${ BUILDING_BLOCKS.join(', ') }`);
        }
    }
    return parsed;
}

export function loadRequests(root: string = evalRoot): Requests {
    return parseRequests(readFileSync(join(root, 'requests.json'), 'utf8'));
}

/**
 * The request's prompt for a run, with the run's local API server in it: `{{frankfurter}}` becomes the Frankfurter
 * API's base URL, and `{{mathjs}}` the math.js API's. So requests.json stays the same whatever port a run gets.
 */
export function promptFor(request: Request, urls: { mathjs: string, frankfurter: string }): string {
    return fillInUrls(request.prompt, urls);
}

/** `text` with `{{frankfurter}}` and `{{mathjs}}` replaced by the local API server's URLs, as in a prompt or a reference solution. */
export function fillInUrls(text: string, urls: { mathjs: string, frankfurter: string }): string {
    return text.replaceAll('{{frankfurter}}', urls.frankfurter).replaceAll('{{mathjs}}', urls.mathjs);
}
