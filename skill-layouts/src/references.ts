// The reference solutions of the requests, and the check that each one works: it passes tsc and npm test in layout
// None's project, with its request's fixture, and fails npm test once its expected value is made wrong. A reference
// that passes either way checks nothing, and a request's needs are the skills its reference solution needs, so the
// harness checks them before every pilot and evaluation.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { ApiServerUrls } from './api-server.ts';
import { evalRoot } from './layouts.ts';
import { fillInUrls, type Request } from './requests.ts';
import { emptyJobDirectories, pointAtLocalApi, resultOf, type RunCommand } from './runs.ts';
import { Results } from './results.ts';
import { Work } from './work.ts';

export const REFERENCE_SOLUTIONS = join(evalRoot, 'fixtures', 'reference-solutions');

/**
 * Marks the expected value of a reference solution, at the end of its line, e.g.
 * `Ensure.that(ResultFile(jobFile), equals('7')),    // wrong: '7' => '8'`, which makes `'7'` `'8'` on that line.
 */
const MARKER = /\s*\/\/ wrong: (.+) => (.+?)\s*$/;

export interface Marker {
    file: string;
    /** 1-based */
    line: number;
    from: string;
    to: string;
}

/** The files of a request's reference solution, by their paths relative to it, e.g. `spec/math-js_api.spec.ts`. */
export function referenceFilesOf(id: string, solutions: string = REFERENCE_SOLUTIONS): Map<string, string> {
    const directory = join(solutions, id);
    if (! existsSync(directory)) {
        throw new Error(`there's no reference solution of ${ id } in ${ solutions }`);
    }
    return new Map(readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name))
        .sort()
        .map(path => [ relative(directory, path).split(sep).join('/'), readFileSync(path, 'utf8') ]));
}

export function markersIn(files: Map<string, string>): Marker[] {
    return [ ...files ].flatMap(([ file, content ]) => content.split('\n').flatMap((text, index) => {
        const marker = MARKER.exec(text);
        return marker ? [ { file, line: index + 1, from: marker[1], to: marker[2] } ] : [];
    }));
}

/** The reference's files without the marker of their expected value, as an exemplar shows them: the code alone. */
export function withoutMarkers(files: Map<string, string>): Map<string, string> {
    return new Map([ ...files ].map(([ file, content ]) => [ file, content.split('\n').map(line => line.replace(MARKER, '')).join('\n') ]));
}

/** The reference's files with its expected value made wrong, as its one marker says, and nothing else changed. */
export function madeWrong(files: Map<string, string>): Map<string, string> {
    const markers = markersIn(files);
    if (markers.length !== 1) {
        throw new Error(`the reference solution has ${ markers.length } markers of its expected value; it needs exactly one`);
    }
    const [ { file, line, from, to } ] = markers;
    const lines = files.get(file)!.split('\n');
    const text = lines[line - 1];
    const code = text.slice(0, MARKER.exec(text)!.index);
    if (! code.includes(from)) {
        throw new Error(`${ file }:${ line }: the marker makes ${ from } wrong, but the code on its line doesn't have ${ from }`);
    }
    lines[line - 1] = `${ code.replace(from, to) }${ text.slice(code.length) }`;
    return new Map([ ...files, [ file, lines.join('\n') ] ]);
}

export type ReferenceCheck =
    | { request: string, ok: true, madeWrong: boolean }
    | { request: string, ok: false, problem: string };

export interface ReferenceCheckOptions {
    /** Layout None's project, as the harness prepares it */
    project: string;
    /** Where the references' working copies go, in `<work>/references/<request id>` */
    work: string;
    /** Where the logs go, in `<results>/<request id>` */
    results: string;
    urls: ApiServerUrls;
    testTimeoutMinutes: number;
    solutions?: string;
    runCommand?: RunCommand;
}

function writeFiles(directory: string, files: Map<string, string>, urls: ApiServerUrls): void {
    for (const [ path, content ] of files) {
        mkdirSync(join(directory, path, '..'), { recursive: true });
        writeFileSync(join(directory, path), fillInUrls(content, urls));
    }
}

/**
 * Checks a request's reference solution: in a copy of the project, with the request's fixture and the reference
 * solution over it, tsc and npm test pass; and with its expected value made wrong, tsc still passes, and npm test
 * fails. The control has no expected value, so it's only checked to pass.
 */
export async function checkReference(request: Request, { project, work, results, urls, testTimeoutMinutes, solutions = REFERENCE_SOLUTIONS, runCommand = resultOf }: ReferenceCheckOptions): Promise<ReferenceCheck> {
    const failed = (problem: string): ReferenceCheck => ({ request: request.id, ok: false, problem });
    const logs = new Results(results).referenceLogs(request.id);
    const log = (name: string) => join(logs, name);

    let files: Map<string, string>;
    let wrong: Map<string, string> | undefined;
    try {
        files = referenceFilesOf(request.id, solutions);
        wrong = request.needs.length === 0 ? undefined : madeWrong(files);
    }
    catch (error) {
        return failed((error as Error).message);
    }

    const directory = new Work(work).reference(request.id);
    rmSync(directory, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
    mkdirSync(logs, { recursive: true });
    cpSync(project, directory, { recursive: true, verbatimSymlinks: true });
    if (request.fixture) {
        cpSync(join(evalRoot, 'fixtures', request.fixture), directory, { recursive: true });
    }
    writeFiles(directory, files, urls);
    pointAtLocalApi(directory, urls);

    const check = (suffix: string) => {
        emptyJobDirectories(directory);
        const tsc = runCommand('npx', [ 'tsc', '--noEmit' ], directory, log(`tsc${ suffix }.log`), testTimeoutMinutes);
        return { tsc, test: tsc.exitCode === 0 ? runCommand('npm', [ 'test' ], directory, log(`test${ suffix }.log`), testTimeoutMinutes) : undefined };
    };

    const right = check('');
    if (right.tsc.exitCode !== 0) {
        return failed(`tsc fails, see ${ log('tsc.log') }`);
    }
    if (right.test!.exitCode !== 0) {
        return failed(`npm test fails, see ${ log('test.log') }`);
    }
    if (! wrong) {
        return { request: request.id, ok: true, madeWrong: false };
    }

    writeFiles(directory, wrong, urls);
    const madeWrongCheck = check('.wrong');
    if (madeWrongCheck.tsc.exitCode !== 0) {
        return failed(`tsc fails with its expected value made wrong, see ${ log('tsc.wrong.log') }`);
    }
    if (madeWrongCheck.test!.exitCode === 0) {
        return failed(`npm test still passes with its expected value made wrong, see ${ log('test.wrong.log') }`);
    }
    return { request: request.id, ok: true, madeWrong: true };
}

export function renderReferenceCheck(check: ReferenceCheck): string {
    if (! check.ok) {
        return `${ check.request }: FAILED: ${ check.problem }`;
    }
    return check.madeWrong
        ? `${ check.request }: ok: passes, and fails with its expected value made wrong`
        : `${ check.request }: ok: passes; the control has no expected value to make wrong`;
}
