// The results of a mode, in <out>/<mode>: the plan, the conditions, each run's files, the reviewer's scores, and the
// summary and comparison written from them. The only code that knows their layout. Every record is read through
// records.ts's validation, and every JSON file is written the same way.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Conditions } from './conditions.ts';
import type { Layout } from './layouts.ts';
import { readConditions, readMapping, readRecord, readScores } from './records.ts';
import type { Agent, PlannedRun, ReviewScores } from './review.ts';
import type { Mode, RunRecord } from './runs.ts';

/** Writes `value` as the harness writes every JSON file: indented by two spaces, with a final newline. */
export function writeJson(file: string, value: unknown): void {
    writeFileSync(file, `${ JSON.stringify(value, null, 2) }\n`);
}

/** The files of one run, in its directory of the results, `runs/<id>`. */
export interface RunFiles {
    readonly directory: string;
    readonly result: string;
    readonly stream: string;
    readonly agentLog: string;
    readonly diff: string;
    readonly reply: string;
    readonly serverLog: string;
    readonly tscLog: string;
    readonly testLog: string;
    /** The log of one attempt at npm test, counting from 1 */
    testAttemptLog(attempt: number): string;
    /** The logs of the network failures' rescore, next to the run's own */
    readonly rescored: { readonly tscLog: string, readonly testLog: string, readonly serverLog: string };
    /** The contents of the run's diff.patch, reply.md or stream.jsonl, or undefined where it doesn't exist */
    read(file: 'diff' | 'reply' | 'stream'): string | undefined;
}

/** The files of the run whose directory is `directory`. */
export function runFiles(directory: string): RunFiles {
    const files = {
        directory,
        result: join(directory, 'result.json'),
        stream: join(directory, 'stream.jsonl'),
        agentLog: join(directory, 'agent.log'),
        diff: join(directory, 'diff.patch'),
        reply: join(directory, 'reply.md'),
        serverLog: join(directory, 'server.jsonl'),
        tscLog: join(directory, 'tsc.log'),
        testLog: join(directory, 'test.log'),
        testAttemptLog: (attempt: number) => join(directory, `test.${ attempt }.log`),
        rescored: {
            tscLog: join(directory, 'tsc.rescored.log'),
            testLog: join(directory, 'test.rescored.log'),
            serverLog: join(directory, 'server.rescored.jsonl'),
        },
    };
    return {
        ...files,
        read: file => existsSync(files[file]) ? readFileSync(files[file], 'utf8') : undefined,
    };
}

/** The name of a mode's results directory: pilot, full, smoke or held-back-<layout>. */
export const modeName = (mode: Mode) => mode.mode === 'held-back' ? `held-back-${ mode.layout }` : mode.mode;

/** The runs planned in a mode's results, of the given agents only. */
export function readPlan(results: string, agents?: readonly Agent[]): PlannedRun[] {
    return new Results(results).plan(agents);
}

export class Results {

    /** The results of a mode, in `<out>/<mode>`. */
    static of(out: string, mode: Mode): Results {
        return new Results(join(out, modeName(mode)));
    }

    /** The results of --check-references, in `<out>/check-references`. */
    static ofReferences(out: string): Results {
        return new Results(join(out, 'check-references'));
    }

    readonly review: string;
    private readonly mapping: string;
    readonly conditionsFile: string;
    private readonly fixtures: string;
    private readonly scoresFile: string;
    readonly summaryMarkdown: string;
    private readonly summaryJson: string;
    readonly compareMarkdown: string;

    readonly directory: string;

    constructor(directory: string) {
        this.directory = directory;
        this.review = join(directory, 'review');
        this.mapping = join(directory, 'mapping.json');
        this.conditionsFile = join(directory, 'conditions.json');
        this.fixtures = join(directory, 'fixtures.json');
        this.scoresFile = join(this.review, 'scores.json');
        this.summaryMarkdown = join(directory, 'summary.md');
        this.summaryJson = join(directory, 'summary.json');
        this.compareMarkdown = join(directory, 'compare.md');
    }

    run(id: string): RunFiles {
        return runFiles(join(this.directory, 'runs', id));
    }

    reviewPacket(id: string): string {
        return join(this.review, `${ id }.md`);
    }

    /** Where the lockfile npm generated the first time a layout was prepared for an --out is saved. */
    savedLockfile(layout: Layout): string {
        return join(this.directory, 'layouts', layout, 'package-lock.json');
    }

    /** Where --check-references keeps a request's logs: its tsc and npm test logs, which references.ts names. */
    referenceLogs(request: string): string {
        return join(this.directory, request);
    }

    /** The log of the local API server --check-references starts for a request. */
    referenceServerLog(request: string): string {
        return join(this.referenceLogs(request), 'server.jsonl');
    }

    hasPlan(): boolean {
        return existsSync(this.mapping);
    }

    plan(agents?: readonly Agent[]): PlannedRun[] {
        return readMapping(this.mapping, agents);
    }

    savePlan(planned: PlannedRun[]): void {
        writeJson(this.mapping, planned);
    }

    hasResult(id: string): boolean {
        return existsSync(this.run(id).result);
    }

    result(id: string): RunRecord {
        return readRecord(this.run(id).result);
    }

    saveResult(id: string, record: RunRecord): void {
        writeJson(this.run(id).result, record);
    }

    /** The planned runs that have a result.json, in the plan's order, with their records. */
    scored(planned: PlannedRun[]): Array<{ run: PlannedRun, record: RunRecord }> {
        return planned.filter(run => this.hasResult(run.id)).map(run => ({ run, record: this.result(run.id) }));
    }

    /** The reviewer's scores, or none before there's a scores.json. */
    scores(): ReviewScores {
        return readScores(this.scoresFile);
    }

    hasScores(): boolean {
        return existsSync(this.scoresFile);
    }

    saveScores(scores: ReviewScores): void {
        mkdirSync(dirname(this.scoresFile), { recursive: true });
        writeJson(this.scoresFile, scores);
    }

    /** conditions.json, or undefined before the first run saved one. */
    conditions(): Conditions | undefined {
        return existsSync(this.conditionsFile) ? readConditions(this.conditionsFile) : undefined;
    }

    saveFixtures(fixtures: object): void {
        writeJson(this.fixtures, fixtures);
    }

    saveSummary(json: object, markdown: string): void {
        writeJson(this.summaryJson, json);
        writeFileSync(this.summaryMarkdown, markdown);
    }

    saveCompare(markdown: string): void {
        writeFileSync(this.compareMarkdown, markdown);
    }
}
