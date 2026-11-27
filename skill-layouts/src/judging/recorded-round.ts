import { basename, dirname } from 'node:path';

import { urlsOf } from '../api-server.ts';
import { referenceFilesOf, withoutMarkers } from '../references.ts';
import { fillInUrls, promptFor, type Request } from '../requests.ts';
import { Results } from '../results.ts';
import type { PlannedRun } from '../review.ts';
import type { JudgeInput, JudgeRule } from './judge.ts';
import type { StartingProject } from './starting-project.ts';
import { Verdict } from './verdict.ts';

/** A run the reviewer scored, with the verdicts they gave, item by item; the items they left blank aren't there. */
export class ReviewedRun {

    static of(round: string, results: Results, run: PlannedRun, verdicts: ReadonlyMap<string, Verdict>): ReviewedRun {
        return new ReviewedRun(round, results, run, verdicts);
    }

    readonly round: string;
    private readonly results: Results;
    readonly run: PlannedRun;
    /** The reviewer's verdicts, in the checklist's order */
    readonly verdicts: ReadonlyMap<string, Verdict>;

    private constructor(round: string, results: Results, run: PlannedRun, verdicts: ReadonlyMap<string, Verdict>) {
        this.round = round;
        this.results = results;
        this.run = run;
        this.verdicts = verdicts;
    }

    get id(): string {
        return this.run.id;
    }

    diff(): string {
        return this.results.run(this.run.id).read('diff') ?? '';
    }

    reply(): string {
        return this.results.run(this.run.id).read('reply') ?? '';
    }

    /**
     * What the judge is given about the run: what the reviewer's packet had, the project before and after, when it could
     * be rebuilt, the rules, those the request exercises first, and the reference, without its expected value's marker.
     */
    judgeInput({ rules, request, port, project, exercises }: { rules: readonly JudgeRule[], request: Request, port: number, project: StartingProject | undefined, exercises: (request: string, rule: string) => boolean }): JudgeInput {
        const urls = urlsOf(port);
        const exercised = rules.filter(rule => exercises(request.id, rule.id));
        return {
            request: promptFor(request, urls),
            diff: this.diff(),
            reply: this.reply(),
            ...(project ? { before: project.before, after: project.after } : {}),
            rules: [ ...exercised, ...rules.filter(rule => ! exercised.includes(rule)) ],
            exercised: exercised.map(rule => rule.id),
            reference: new Map([ ...withoutMarkers(referenceFilesOf(request.id)) ].map(([ file, content ]) => [ file, fillInUrls(content, urls) ])),
        };
    }
}

/** A round the reviewer scored: its name, the runs they reviewed, and the template commit and port the runs had. */
export class RecordedRound {

    private static readonly modes = /^(pilot|full|smoke|held-back-.+)$/;

    /** A round's name: its directory's, or, for a mode's results such as `<round>/pilot`, the round's. */
    static nameOf(directory: string): string {
        return RecordedRound.modes.test(basename(directory)) ? basename(dirname(directory)) : basename(directory);
    }

    /**
     * The round whose results are in `directory`, with the runs the reviewer scored at least one of `items` of, in the
     * plan's order. A run without its port recorded had the local API server on `defaultPort`.
     */
    static at(directory: string, { items, defaultPort, name = RecordedRound.nameOf(directory) }: { items: readonly string[], defaultPort: number, name?: string }): RecordedRound {
        const results = new Results(directory);
        const scores = results.scores();
        const reviewed = results.plan().flatMap(planned => {
            const verdicts = new Map(items.flatMap(item => {
                const verdict = Verdict.fromReview(scores[planned.id]?.[item as never], `${ item } of run ${ planned.id }, in ${ name }`);
                return verdict ? [ [ item, verdict ] as const ] : [];
            }));
            if (verdicts.size === 0) {
                return [];
            }
            if (results.run(planned.id).read('diff') === undefined) {
                throw new Error(`run ${ planned.id }, in ${ name }, was reviewed, but has no diff.patch`);
            }
            return [ ReviewedRun.of(name, results, planned, verdicts) ];
        });
        const conditions = results.conditions();
        if (! conditions?.shared?.template?.commit) {
            throw new Error(`${ name }'s conditions.json doesn't record the template's commit, which the runs started from`);
        }
        return new RecordedRound(name, reviewed, conditions.shared.template.commit, conditions.shared.apiServer?.port ?? defaultPort);
    }

    readonly name: string;
    readonly reviewedRuns: readonly ReviewedRun[];
    readonly templateCommit: string;
    readonly port: number;

    private constructor(name: string, reviewedRuns: readonly ReviewedRun[], templateCommit: string, port: number) {
        this.name = name;
        this.reviewedRuns = reviewedRuns;
        this.templateCommit = templateCommit;
        this.port = port;
    }
}
