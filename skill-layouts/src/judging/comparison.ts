import type { Ballot } from './ballot.ts';
import { Verdict } from './verdict.ts';

/** Where a comparison falls in the table of where the judge differs from the reviewer, when it does. */
export type Difference = 'reviewerPassJudgeFail' | 'reviewerFailJudgePass' | 'otherNa' | 'split' | 'incomplete' | 'missing';

/** A column of that table: the comparisons it counts. No comparison falls in two. */
interface DifferenceColumn {
    name: Difference;
    counts(reviewer: Verdict, ballot: Ballot): boolean;
}

/** The reviewer's verdict on one run and one item, against the judge's ballot on it. */
export class Comparison {

    /** The table of where the judge differs from the reviewer, in the order of its columns */
    static readonly differences: readonly DifferenceColumn[] = [
        { name: 'reviewerPassJudgeFail', counts: (reviewer, { majority }) => reviewer === Verdict.pass && majority === Verdict.fail },
        { name: 'reviewerFailJudgePass', counts: (reviewer, { majority }) => reviewer === Verdict.fail && majority === Verdict.pass },
        {
            name: 'otherNa',
            counts: (reviewer, { majority }) => majority !== undefined && majority !== reviewer && (reviewer === Verdict.notApplicable || majority === Verdict.notApplicable),
        },
        { name: 'split', counts: (_, { result }) => result === 'split' },
        { name: 'incomplete', counts: (_, { result }) => result === 'incomplete' },
        { name: 'missing', counts: (_, { result }) => result === 'missing' },
    ];

    static of({ round, run, item, reviewer, heldOut, withoutProject = false, ballot }: { round: string, run: string, item: string, reviewer: Verdict, heldOut: boolean, withoutProject?: boolean, ballot: Ballot }): Comparison {
        return new Comparison(round, run, item, reviewer, heldOut, withoutProject, ballot);
    }

    readonly round: string;
    readonly run: string;
    readonly item: string;
    readonly reviewer: Verdict;
    /** Whether the guide doesn't cite the run under a section that names the item */
    readonly heldOut: boolean;
    /** Whether the judge had only the diff, since the run's project couldn't be rebuilt */
    readonly withoutProject: boolean;
    readonly ballot: Ballot;

    private constructor(
        round: string,
        run: string,
        item: string,
        reviewer: Verdict,
        heldOut: boolean,
        withoutProject: boolean,
        ballot: Ballot,
    ) {
        this.round = round;
        this.run = run;
        this.item = item;
        this.reviewer = reviewer;
        this.heldOut = heldOut;
        this.withoutProject = withoutProject;
        this.ballot = ballot;
    }

    /** Whether it counts towards the agreement: a ballot no session voted in doesn't; a split or incomplete one does, against */
    isJudged(): boolean {
        return this.ballot.isCast();
    }

    agrees(): boolean {
        return this.ballot.majority === this.reviewer;
    }

    /** Whether the judge's ballot came to anything but the reviewer's verdict, a missing ballot aside */
    isDisagreement(): boolean {
        return this.isJudged() && ! this.agrees();
    }

    isReviewersFail(): boolean {
        return this.reviewer === Verdict.fail;
    }

    judgeFails(): boolean {
        return this.ballot.majority === Verdict.fail;
    }

    isReviewersPass(): boolean {
        return this.reviewer === Verdict.pass;
    }

    judgePasses(): boolean {
        return this.ballot.majority === Verdict.pass;
    }

    /** Where it falls in the table of differences, or undefined when the judge agrees */
    difference(): Difference | undefined {
        return Comparison.differences.find(column => column.counts(this.reviewer, this.ballot))?.name;
    }

    toJSON() {
        return {
            round: this.round,
            run: this.run,
            item: this.item,
            reviewer: this.reviewer.name,
            heldOut: this.heldOut,
            ...(this.withoutProject ? { withoutProject: true } : {}),
            judged: this.ballot,
        };
    }
}
