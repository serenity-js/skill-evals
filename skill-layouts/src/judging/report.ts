import type { BallotResult } from './ballot.ts';
import { Comparison, type Difference } from './comparison.ts';
import type { JudgeSession } from './judge.ts';
import type { CalibrationProtocol, CalibrationStatus } from './protocol.ts';
import type { JudgeIdentity } from './session-store.ts';
import { Share } from './share.ts';
import { Verdict, type VerdictName } from './verdict.ts';

/** How the judge did on one item of the checklist. */
export interface ItemCalibration {
    item: string;
    reviewer: Record<VerdictName, number>;
    /** The judge's majority agrees with the reviewer, of the comparisons the judge voted in */
    agreement: Share;
    heldOut: Share;
    /** Of the reviewer's fails, how many the judge's majority failed too, in every run, for the report */
    failsCaught: Share;
    /** The same, of the held-out verdicts only, which the decision uses: the guide cites the others' failures to the judge */
    heldOutFailsCaught: Share;
    /** Of the reviewer's held-out passes, how many the judge's majority passed too */
    heldOutPassesKept: Share;
    /** Split and incomplete results count against the agreement; missing ones, where no session gave a verdict, don't count at all */
    confusion: Record<Difference, number>;
    /** Of the runs with two sessions' verdicts or more, how many had every session agree */
    unanimous: Share;
    status: CalibrationStatus;
    why: string;
}

export interface Disagreement {
    round: string;
    run: string;
    item: string;
    reviewer: VerdictName;
    judge: BallotResult;
    heldOut: boolean;
    /** Each session's verdict and reason */
    reasons: string[];
}

/** What the sessions cost. */
export interface SessionsSummary {
    sessions: number;
    /** Sessions that left no usable verdicts, after their second attempt */
    withoutVerdicts: number;
    /** Sessions that needed a second attempt */
    retried: number;
    credits: number;
    durationMs: number;
}

/** What the sessions of a calibration cost, added up. */
export function sessionsSummaryOf(sessions: readonly JudgeSession[]): SessionsSummary {
    return {
        sessions: sessions.length,
        withoutVerdicts: sessions.filter(session => ! session.verdicts).length,
        retried: sessions.filter(session => session.wasRetried()).length,
        credits: sessions.reduce((total, session) => total + (session.credits ?? 0), 0),
        durationMs: sessions.reduce((total, session) => total + session.durationMs, 0),
    };
}

/** A run the judge scored from its diff alone, since its project couldn't be rebuilt, and why. */
export interface RunWithoutProject {
    round: string;
    run: string;
    reason: string;
}

/** How the judge's verdicts compare with the reviewer's, item by item and round by round, with every disagreement. */
export class CalibrationReport {

    /**
     * The report of `comparisons`, with an item for every item of `items` they have, in that order, each decided by
     * `protocol`.
     */
    static of(
        comparisons: readonly Comparison[],
        { items, protocol, judge, sessions, withoutProject }: { items: readonly string[], protocol: CalibrationProtocol, judge: JudgeIdentity, sessions: SessionsSummary, withoutProject: readonly RunWithoutProject[] },
    ): CalibrationReport {
        const ofItems = items
            .map(item => comparisons.filter(comparison => comparison.item === item))
            .filter(ofItem => ofItem.length > 0)
            .map(ofItem => CalibrationReport.itemOf(ofItem, protocol));
        const rounds = [ ...new Set(comparisons.map(comparison => comparison.round)) ].map(round => {
            const ofRound = comparisons.filter(comparison => comparison.round === round);
            return { round, agreement: CalibrationReport.agreementOf(ofRound), heldOut: CalibrationReport.agreementOf(ofRound.filter(comparison => comparison.heldOut)) };
        });
        const disagreements = comparisons.filter(comparison => comparison.isDisagreement()).map((comparison): Disagreement => ({
            round: comparison.round,
            run: comparison.run,
            item: comparison.item,
            reviewer: comparison.reviewer.name,
            judge: comparison.ballot.result,
            heldOut: comparison.heldOut,
            reasons: comparison.ballot.reasons(),
        }));
        return new CalibrationReport(judge, ofItems, rounds, disagreements, sessions, withoutProject);
    }

    /** Of the comparisons the judge voted in, those it agrees with the reviewer on */
    private static agreementOf(comparisons: readonly Comparison[]): Share {
        return Share.counting(comparisons.filter(comparison => comparison.isJudged()), comparison => comparison.agrees());
    }

    private static itemOf(comparisons: readonly Comparison[], protocol: CalibrationProtocol): ItemCalibration {
        const fails = comparisons.filter(comparison => comparison.isReviewersFail());
        const evidence = {
            heldOut: CalibrationReport.agreementOf(comparisons.filter(comparison => comparison.heldOut)),
            heldOutFailsCaught: Share.counting(fails.filter(comparison => comparison.heldOut), comparison => comparison.judgeFails()),
            heldOutPassesKept: Share.counting(comparisons.filter(comparison => comparison.heldOut && comparison.isReviewersPass()), comparison => comparison.judgePasses()),
        };
        return {
            item: comparisons[0].item,
            reviewer: Object.fromEntries(Verdict.all.map(verdict => [ verdict.name, comparisons.filter(comparison => comparison.reviewer === verdict).length ])) as Record<VerdictName, number>,
            agreement: CalibrationReport.agreementOf(comparisons),
            heldOut: evidence.heldOut,
            failsCaught: Share.counting(fails, comparison => comparison.judgeFails()),
            heldOutFailsCaught: evidence.heldOutFailsCaught,
            heldOutPassesKept: evidence.heldOutPassesKept,
            confusion: Object.fromEntries(Comparison.differences.map(({ name }) => [ name, comparisons.filter(comparison => comparison.difference() === name).length ])) as Record<Difference, number>,
            unanimous: Share.counting(comparisons.filter(comparison => comparison.ballot.canBeUnanimous()), comparison => comparison.ballot.isUnanimous()),
            ...protocol.decide(evidence),
        };
    }

    readonly judge: JudgeIdentity;
    readonly items: readonly ItemCalibration[];
    readonly rounds: ReadonlyArray<{ round: string, agreement: Share, heldOut: Share }>;
    readonly disagreements: readonly Disagreement[];
    readonly sessions: SessionsSummary;
    /** The runs whose project couldn't be rebuilt, which the judge scored from their diff alone, and why */
    readonly withoutProject: readonly RunWithoutProject[];

    private constructor(
        judge: JudgeIdentity,
        items: readonly ItemCalibration[],
        rounds: ReadonlyArray<{ round: string, agreement: Share, heldOut: Share }>,
        disagreements: readonly Disagreement[],
        sessions: SessionsSummary,
        withoutProject: readonly RunWithoutProject[],
    ) {
        this.judge = judge;
        this.items = items;
        this.rounds = rounds;
        this.disagreements = disagreements;
        this.sessions = sessions;
        this.withoutProject = withoutProject;
    }
}
