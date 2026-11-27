import { basename, dirname } from 'node:path';

import { urlsOf } from '../api-server.ts';
import { fillInUrls, promptFor, type Request } from '../requests.ts';
import { Results } from '../results.ts';
import type { Blinding, PlannedRun } from '../review.ts';
import { JudgeBrief, type JudgeRule } from './brief.ts';
import type { StartingProject } from './starting-project.ts';
import { Verdict } from './verdict.ts';

/** A run the reviewer scored: the verdicts they gave, item by item, without the items they left blank, and its diff and reply. */
export class ReviewedRun {

    static of({ round, run, verdicts, diff, reply }: { round: string, run: PlannedRun, verdicts: ReadonlyMap<string, Verdict>, diff: string, reply: string }): ReviewedRun {
        return new ReviewedRun(round, run, verdicts, diff, reply);
    }

    readonly round: string;
    readonly run: PlannedRun;
    /** The reviewer's verdicts, in the checklist's order */
    readonly verdicts: ReadonlyMap<string, Verdict>;
    readonly diff: string;
    /** What the agent said at the end, or '' */
    readonly reply: string;

    private constructor(round: string, run: PlannedRun, verdicts: ReadonlyMap<string, Verdict>, diff: string, reply: string) {
        this.round = round;
        this.run = run;
        this.verdicts = verdicts;
        this.diff = diff;
        this.reply = reply;
    }

    get id(): string {
        return this.run.id;
    }

    /**
     * What the judge is given about the run: what the reviewer's packet had, blinded, the project before and after,
     * when it could be rebuilt, the rules, those the request exercises first, and the request's reference solution,
     * without its expected value's marker, with the round's URLs filled in.
     */
    brief({ rules, request, port, project, exercises, reference, blinding }: {
        rules: readonly JudgeRule[],
        request: Request,
        port: number,
        project: StartingProject | undefined,
        exercises: (request: string, rule: string) => boolean,
        reference: ReadonlyMap<string, string>,
        blinding: Blinding,
    }): JudgeBrief {
        const urls = urlsOf(port);
        const exercised = rules.filter(rule => exercises(request.id, rule.id));
        return JudgeBrief.of({
            request: promptFor(request, urls),
            diff: this.diff,
            reply: this.reply,
            rules: [ ...exercised, ...rules.filter(rule => ! exercised.includes(rule)) ],
            exercised: exercised.map(rule => rule.id),
            reference: new Map([ ...reference ].map(([ file, content ]) => [ file, fillInUrls(content, urls) ])),
            ...(project ? { project } : {}),
        }, blinding);
    }
}

/** A round the reviewer scored: its name, the runs they reviewed, and the template commit and port the runs had. */
export class RecordedRound {

    private static readonly modes = /^(pilot|full|smoke|held-back-.+)$/;

    /** A round's name: its directory's, or, for a mode's results such as `<round>/pilot`, the round's. */
    static nameOf(directory: string): string {
        return RecordedRound.modes.test(basename(directory)) ? basename(dirname(directory)) : basename(directory);
    }

    static of({ name, reviewedRuns, templateCommit, port }: { name: string, reviewedRuns: readonly ReviewedRun[], templateCommit: string, port: number }): RecordedRound {
        return new RecordedRound(name, reviewedRuns, templateCommit, port);
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

/** Reads the rounds the reviewer scored, for the checklist's items, from their results. */
export class RecordedRounds {

    private readonly items: readonly string[];
    private readonly defaultPort: number;

    /** For the checklist's `items`, in its order; a round without its port recorded had the local API server on `defaultPort` */
    constructor({ items, defaultPort }: { items: readonly string[], defaultPort: number }) {
        this.items = items;
        this.defaultPort = defaultPort;
    }

    /**
     * The round whose results are in `directory`, with the runs the reviewer scored at least one item of, in the plan's
     * order. It refuses a verdict that isn't one, a reviewed run without its diff, and a round that doesn't record the
     * template's commit, naming the round.
     */
    read(directory: string, name: string = RecordedRound.nameOf(directory)): RecordedRound {
        const results = new Results(directory);
        const scores = results.scores();
        const reviewedRuns = results.plan().flatMap(planned => {
            const verdicts = new Map(this.items.flatMap(item => {
                const verdict = Verdict.fromReview(scores[planned.id]?.[item as never], `${ item } of run ${ planned.id }, in ${ name }`);
                return verdict ? [ [ item, verdict ] as const ] : [];
            }));
            if (verdicts.size === 0) {
                return [];
            }
            const files = results.run(planned.id);
            const diff = files.read('diff');
            if (diff === undefined) {
                throw new Error(`run ${ planned.id }, in ${ name }, was reviewed, but has no diff.patch`);
            }
            return [ ReviewedRun.of({ round: name, run: planned, verdicts, diff, reply: files.read('reply') ?? '' }) ];
        });
        const conditions = results.conditions();
        if (! conditions?.shared?.template?.commit) {
            throw new Error(`${ name }'s conditions.json doesn't record the template's commit, which the runs started from`);
        }
        return RecordedRound.of({ name, reviewedRuns, templateCommit: conditions.shared.template.commit, port: conditions.shared.apiServer?.port ?? this.defaultPort });
    }
}
