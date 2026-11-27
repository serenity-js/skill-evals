import type { RuleVerdict } from './rule-verdict.ts';
import { Verdict, type VerdictName } from './verdict.ts';

/**
 * What a ballot comes to: the verdict more than half of the planned sessions agree on, or, without one, `split` when
 * every session gave a verdict, `incomplete` when some left none, and `missing` when none gave one.
 */
export type BallotResult = VerdictName | 'split' | 'incomplete' | 'missing';

/** The judge's sessions' verdicts on one run and one rule, one per planned session; undefined for a session that left none. */
export class Ballot {

    /** What a ballot comes to: the first of these that applies to it */
    private static readonly results: ReadonlyArray<{ applies: (ballot: Ballot) => boolean, result: (ballot: Ballot) => BallotResult }> = [
        { applies: ({ majority }) => majority !== undefined, result: ({ majority }) => majority!.name },
        { applies: ballot => ballot.given().length === 0, result: () => 'missing' },
        { applies: ballot => ballot.given().length === ballot.votes.length, result: () => 'split' },
        { applies: () => true, result: () => 'incomplete' },
    ];

    static of(votes: ReadonlyArray<RuleVerdict | undefined>): Ballot {
        return new Ballot(votes);
    }

    /** The verdict more than half of the planned sessions gave, if any */
    readonly majority: Verdict | undefined;
    readonly result: BallotResult;

    readonly votes: ReadonlyArray<RuleVerdict | undefined>;

    private constructor(votes: ReadonlyArray<RuleVerdict | undefined>) {
        this.votes = votes;
        const given = this.given();
        const counts = Verdict.all
            .map(verdict => ({ verdict, count: given.filter(vote => vote.verdict === verdict).length }))
            .sort((one, other) => other.count - one.count);
        this.majority = counts[0].count * 2 > votes.length ? counts[0].verdict : undefined;
        this.result = Ballot.results.find(({ applies }) => applies(this))!.result(this);
    }

    /** The verdicts the sessions gave */
    given(): RuleVerdict[] {
        return this.votes.filter((vote): vote is RuleVerdict => vote !== undefined);
    }

    /** Whether any session gave a verdict */
    isCast(): boolean {
        return this.result !== 'missing';
    }

    /** Whether at least two sessions gave verdicts, so they can agree with each other or not */
    canBeUnanimous(): boolean {
        return this.given().length >= 2;
    }

    /** Whether every session that gave a verdict gave the same one */
    isUnanimous(): boolean {
        return new Set(this.given().map(vote => vote.verdict)).size === 1;
    }

    /** Each session's verdict and reason, as `<verdict>: <reason>` */
    reasons(): string[] {
        return this.given().map(vote => vote.toString());
    }

    /** One entry per planned session, null for a session that left no verdict */
    toJSON(): ReadonlyArray<RuleVerdict | undefined> {
        return this.votes;
    }
}
