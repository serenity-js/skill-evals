import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkReferences, parseArguments } from '../src/cli.ts';
import { evalRoot } from '../src/layouts.ts';
import { checkReference, madeWrong, markersIn, referenceFilesOf, renderReferenceCheck } from '../src/references.ts';
import { loadRequests, type Request } from '../src/requests.ts';
import type { RunCommand } from '../src/runs.ts';

const urls = { mathjs: 'http://127.0.0.1:4170/v4/', frankfurter: 'http://127.0.0.1:4170/v1' };
const request: Request = { id: '3-check-a-value', kind: '', prompt: 'Check it.', needs: [ 'questions', 'tests' ], apis: [ 'mathjs' ] };
const control: Request = { id: '8-control', kind: '', prompt: 'Update the README.', needs: [], apis: [ 'mathjs' ] };
const template = { name: 'template', scripts: { test: 'cross-env BASE_API_URL=http://api.mathjs.org/v4/ mocha' } };

describe('the reference solutions', () => {

    const { requests, heldBack } = loadRequests();
    const all = [ ...requests, ...heldBack ];

    it('cover every request, held back or not, in fixtures/reference-solutions/<request id>/', () => {
        expect(all.filter(({ id }) => ! existsSync(join(evalRoot, 'fixtures', 'reference-solutions', id))).map(({ id }) => id)).toEqual([]);
    });

    it("mark the expected value of each, but the control's, once, with what makes it wrong", () => {
        const marked = Object.fromEntries(all.map(({ id }) => [ id, markersIn(referenceFilesOf(id)).length ]));

        expect(marked).toEqual(Object.fromEntries(all.map(({ id, needs }) => [ id, needs.length === 0 ? 0 : 1 ])));
    });

    it('can each be made wrong by its marker', () => {
        for (const { id } of all.filter(({ needs }) => needs.length > 0)) {
            expect(() => madeWrong(referenceFilesOf(id)), id).not.toThrow();
        }
    });
});

describe('making a reference wrong', () => {

    const files = (spec: string) => new Map([ [ 'spec/x.spec.ts', spec ] ]);

    it('replaces what the marker names on its own line, and leaves the rest of the file as it was', () => {
        const wrong = madeWrong(files([
            "Ensure.that(Result(), equals('7')),    // wrong: '7' => '8'",
            "Ensure.that(Other(), equals('7')),",
        ].join('\n')));

        expect(wrong.get('spec/x.spec.ts')).toBe([
            "Ensure.that(Result(), equals('8')),    // wrong: '7' => '8'",
            "Ensure.that(Other(), equals('7')),",
        ].join('\n'));
    });

    it("refuses a marker whose value isn't on its line, so a stale marker can't make a check pass", () => {
        expect(() => madeWrong(files("Ensure.that(Result(), equals('7')),    // wrong: '6' => '8'")))
            .toThrow("spec/x.spec.ts:1: the marker makes '6' wrong, but the code on its line doesn't have '6'");
    });

    it('refuses a reference with more than one marker, or none', () => {
        expect(() => madeWrong(files("equals(1)    // wrong: 1 => 2\nequals(3)    // wrong: 3 => 4")))
            .toThrow('the reference solution has 2 markers of its expected value; it needs exactly one');
        expect(() => madeWrong(files('equals(1)')))
            .toThrow('the reference solution has 0 markers of its expected value; it needs exactly one');
    });
});

describe('checking a reference solution', () => {

    let root: string;
    let project: string;
    let work: string;
    let results: string;
    let solutions: string;

    const commandsIn = (calls: string[]) => calls.map(call => call.split(' > ')[0]);

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'skill-layouts-references-'));
        project = join(root, 'project');
        work = join(root, 'work');
        results = join(root, 'results');
        solutions = join(root, 'solutions');
        mkdirSync(join(project, 'spec'), { recursive: true });
        writeFileSync(join(project, 'package.json'), JSON.stringify(template));
        mkdirSync(join(solutions, request.id, 'spec'), { recursive: true });
        writeFileSync(join(solutions, request.id, 'spec', 'x.spec.ts'), "Ensure.that(Result(), isLessThan(First())),    // wrong: isLessThan => isGreaterThan\n");
        mkdirSync(join(solutions, control.id), { recursive: true });
        writeFileSync(join(solutions, control.id, 'README.md'), 'Node.js 22 or later\n');
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    // tsc passes; npm test passes while the scenario says isLessThan, as a correct reference does
    const passingWhileRight = (calls: string[], directory = () => join(work, 'references', request.id)): RunCommand => (command, args, cwd, logFile) => {
        calls.push(`${ command } ${ args.join(' ') } > ${ logFile.split('/').pop() }`);
        expect(cwd).toBe(directory());
        const spec = join(cwd, 'spec', 'x.spec.ts');
        const exitCode = command === 'npm' && existsSync(spec) && readFileSync(spec, 'utf8').includes('isGreaterThan(') ? 1 : 0;
        writeFileSync(logFile, `exited with ${ exitCode }`);
        return { exitCode, log: `exited with ${ exitCode }` };
    };

    it('passes a reference that passes tsc and npm test, and fails npm test, but not tsc, with its expected value made wrong', async () => {
        const calls: string[] = [];

        const check = await checkReference(request, { project, work, results, urls, solutions, runCommand: passingWhileRight(calls), testTimeoutMinutes: 1 });

        expect(check).toMatchObject({ request: request.id, ok: true });
        expect(calls).toEqual([
            'npx tsc --noEmit > tsc.log', 'npm test > test.log',
            'npx tsc --noEmit > tsc.wrong.log', 'npm test > test.wrong.log',
        ]);
        expect(renderReferenceCheck(check)).toBe('3-check-a-value: ok: passes, and fails with its expected value made wrong');
    });

    it('fails a reference that still passes with its expected value made wrong', async () => {
        const check = await checkReference(request, { project, work, results, urls, solutions, testTimeoutMinutes: 1, runCommand: (_, __, ___, logFile) => {
            writeFileSync(logFile, '');
            return { exitCode: 0, log: '' };
        } });

        expect(check.ok).toBe(false);
        expect(renderReferenceCheck(check)).toBe(`3-check-a-value: FAILED: npm test still passes with its expected value made wrong, see ${ join(results, request.id, 'test.wrong.log') }`);
    });

    it("fails a reference whose own npm test fails, and doesn't make it wrong", async () => {
        const calls: string[] = [];

        const check = await checkReference(request, { project, work, results, urls, solutions, testTimeoutMinutes: 1, runCommand: (command, args, _, logFile) => {
            calls.push(`${ command } ${ args.join(' ') }`);
            writeFileSync(logFile, '');
            return { exitCode: command === 'npm' ? 1 : 0, log: '' };
        } });

        expect(calls).toEqual([ 'npx tsc --noEmit', 'npm test' ]);
        expect(renderReferenceCheck(check)).toBe(`3-check-a-value: FAILED: npm test fails, see ${ join(results, request.id, 'test.log') }`);
    });

    it("fails a reference that doesn't compile with its expected value made wrong, since its npm test would fail for the wrong reason", async () => {
        const check = await checkReference(request, { project, work, results, urls, solutions, testTimeoutMinutes: 1, runCommand: (_, __, ___, logFile) => {
            const exitCode = logFile.endsWith('.wrong.log') ? 1 : 0;
            writeFileSync(logFile, '');
            return { exitCode, log: '' };
        } });

        expect(renderReferenceCheck(check)).toBe(`3-check-a-value: FAILED: tsc fails with its expected value made wrong, see ${ join(results, request.id, 'tsc.wrong.log') }`);
    });

    it("checks the control with its reference only, since it has no expected value to make wrong", async () => {
        const calls: string[] = [];

        const check = await checkReference(control, { project, work, results, urls, solutions, testTimeoutMinutes: 1, runCommand: passingWhileRight(calls, () => join(work, 'references', control.id)) });

        expect(commandsIn(calls)).toEqual([ 'npx tsc --noEmit', 'npm test' ]);
        expect(renderReferenceCheck(check)).toBe('8-control: ok: passes; the control has no expected value to make wrong');
        expect(readFileSync(join(work, 'references', control.id, 'README.md'), 'utf8')).toBe('Node.js 22 or later\n');
    });

    it("copies the request's fixture, then its reference solution, over the project, and points the test script at the local API server", async () => {
        const request9: Request = { ...request, id: '9-new-interface', fixture: 'calculation-job-results' };
        mkdirSync(join(solutions, request9.id, 'spec'), { recursive: true });
        writeFileSync(join(solutions, request9.id, 'spec', 'x.spec.ts'), "equals('7')    // wrong: '7' => '8'\n");
        const directory = join(work, 'references', request9.id);

        await checkReference(request9, { project, work, results, urls, solutions, testTimeoutMinutes: 1, runCommand: (_, __, ___, logFile) => {
            writeFileSync(logFile, '');
            return { exitCode: logFile.endsWith('test.wrong.log') ? 1 : 0, log: '' };
        } });

        expect(existsSync(join(directory, 'system-under-test', 'CalculationJobs.ts'))).toBe(true);
        expect(readFileSync(join(directory, 'spec', 'x.spec.ts'), 'utf8')).toContain("equals('8')");
        expect((JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as typeof template).scripts.test).toBe('cross-env BASE_API_URL=http://127.0.0.1:4170/v4/ mocha');
    });

    it("fills in the local API server's URLs, as request 4's prompt names them", async () => {
        writeFileSync(join(solutions, request.id, 'spec', 'x.spec.ts'), "GetRequest.to('{{frankfurter}}/latest'), equals(1)    // wrong: 1 => 2\n");

        await checkReference(request, { project, work, results, urls, solutions, testTimeoutMinutes: 1, runCommand: (_, __, ___, logFile) => {
            writeFileSync(logFile, '');
            return { exitCode: logFile.endsWith('test.wrong.log') ? 1 : 0, log: '' };
        } });

        expect(readFileSync(join(work, 'references', request.id, 'spec', 'x.spec.ts'), 'utf8')).toContain("GetRequest.to('http://127.0.0.1:4170/v1/latest')");
    });

    it('empties JOBS_DIR and RESULTS_DIR before each npm test, so a result file the reference left in its first run can\'t make the second pass', async () => {
        const directory = join(work, 'references', request.id);
        const leftovers: boolean[] = [];

        await checkReference(request, { project, work, results, urls, solutions, testTimeoutMinutes: 1, runCommand: (command, _, __, logFile) => {
            if (command === 'npm') {
                leftovers.push(existsSync(join(directory, 'job-results', 'job-1')));
                mkdirSync(join(directory, 'job-results'), { recursive: true });
                writeFileSync(join(directory, 'job-results', 'job-1'), '7');
            }
            writeFileSync(logFile, '');
            return { exitCode: logFile.endsWith('test.wrong.log') ? 1 : 0, log: '' };
        } });

        expect(leftovers).toEqual([ false, false ]);
    });
});

describe('--check-references', () => {

    it('checks the reference solutions, in <out>/check-references, with a compiled serenity-js clone', () => {
        const args = parseArguments([ '--check-references', '--serenity-js', '/clone', '--out', '/out' ], '/');

        expect(args).toMatchObject({ checkReferencesOnly: true, serenityJs: '/clone', out: '/out' });
    });

    it('needs the serenity-js clone, to pack the packages layout None installs', () => {
        expect(() => parseArguments([ '--check-references', '--out', '/out' ], '/')).toThrow(/--serenity-js <clone> is required/);
    });

    it("doesn't combine with a mode or another action, since it runs no agent", () => {
        for (const other of [ '--pilot', '--smoke', '--prepare-only', '--summarise', '--rescore', '--reparse' ]) {
            expect(() => parseArguments([ '--check-references', other, '--serenity-js', '/clone', '--out', '/out' ], '/'), other).toThrow(/usage/);
        }
        expect(() => parseArguments([ '--check-references', '--held-back', 'b', '--serenity-js', '/clone', '--out', '/out' ], '/')).toThrow(/usage/);
    });

    it("refuses to check anything where sandbox-exec can't start, before it packs or prepares anything", async () => {
        const args = parseArguments([ '--check-references', '--serenity-js', '/no-such-clone', '--out', '/no-such-out' ], '/');

        await expect(checkReferences(args, { sandboxProblems: () => [ "sandbox-exec can't start here" ] }))
            .rejects.toThrow("nothing checked: sandbox-exec can't start here");
    });
});
