import type { Share } from './share.ts';

export type CalibrationStatus = 'calibrated' | 'calibrated against false alarms only' | 'calibrated against misses only' | 'not calibrated' | 'too few held-out verdicts';

/**
 * What the protocol decides an item from: the judge's agreement with the held-out verdicts, the held-out fails it
 * caught, and the held-out passes it kept.
 */
export interface ItemEvidence {
    heldOut: Share;
    heldOutFailsCaught: Share;
    heldOutPassesKept: Share;
}

/** A share the judge has to reach, as a fraction, and in words, as the reports say it, such as `two thirds`. */
export interface Threshold {
    fraction: number;
    words: string;
}

/** One of the protocol's criteria: when it's met, it decides the item's status, and says why. */
interface Criterion {
    status: CalibrationStatus;
    isMet(evidence: ItemEvidence): boolean;
    why(evidence: ItemEvidence): string;
}

const plural = (count: number, noun: string) => `${ count } ${ noun }${ count === 1 ? '' : 's' }`;

/**
 * The calibration's protocol, decided before the judge scores anything, as the README's "Calibrating the judge" says:
 * how many sessions judge each run, and when an item counts as calibrated. Its decision is the first of its criteria
 * that an item meets, in order; the last, calibrated, is met by any item that gets that far.
 */
export class CalibrationProtocol {

    readonly sessionsPerRun: number;
    /** The share of held-out verdicts the judge has to agree with, of at least `minHeldOut` */
    readonly agreement: number;
    readonly minHeldOut: number;
    /** With at least `minFails` of the reviewer's held-out fails, the judge has to fail at least `caught` of those runs too */
    readonly minFails: number;
    readonly caught: Threshold;
    /** With fewer than `minPasses` of the reviewer's held-out passes, the agreement can't show that the judge tells a pass */
    readonly minPasses: number;

    private readonly criteria: readonly Criterion[];

    constructor({ sessionsPerRun = 3, agreement = 0.85, minHeldOut = 10, minFails = 3, caught = { fraction: 2 / 3, words: 'two thirds' }, minPasses = 3 }: Partial<Pick<CalibrationProtocol, 'sessionsPerRun' | 'agreement' | 'minHeldOut' | 'minFails' | 'caught' | 'minPasses'>> = {}) {
        this.sessionsPerRun = sessionsPerRun;
        this.agreement = agreement;
        this.minHeldOut = minHeldOut;
        this.minFails = minFails;
        this.caught = caught;
        this.minPasses = minPasses;
        this.criteria = [
            {
                status: 'too few held-out verdicts',
                isMet: ({ heldOut }) => heldOut.of < minHeldOut,
                why: ({ heldOut }) => `${ plural(heldOut.of, 'held-out verdict') }, of the ${ minHeldOut } it needs`,
            },
            {
                status: 'not calibrated',
                isMet: ({ heldOut }) => ! heldOut.isAtLeast(agreement),
                why: ({ heldOut }) => `agrees with ${ heldOut } held-out verdicts, under ${ agreement * 100 }%`,
            },
            {
                status: 'calibrated against false alarms only',
                isMet: ({ heldOutFailsCaught }) => heldOutFailsCaught.of < minFails,
                why: ({ heldOutFailsCaught }) => `the reviewer failed it in ${ plural(heldOutFailsCaught.of, 'held-out verdict') }, fewer than ${ minFails }, so the agreement can't show that the judge tells a failure`,
            },
            {
                status: 'not calibrated',
                isMet: ({ heldOutFailsCaught }) => ! heldOutFailsCaught.isAtLeast(caught.fraction),
                why: ({ heldOutFailsCaught }) => `fails ${ heldOutFailsCaught } of the held-out runs the reviewer failed, under ${ caught.words }`,
            },
            {
                status: 'calibrated against misses only',
                isMet: ({ heldOutPassesKept }) => heldOutPassesKept.of < minPasses,
                why: ({ heldOutPassesKept }) => `the reviewer passed it in ${ plural(heldOutPassesKept.of, 'held-out verdict') }, fewer than ${ minPasses }, so the agreement can't show that the judge tells a pass`,
            },
            {
                status: 'calibrated',
                isMet: () => true,
                why: ({ heldOut, heldOutFailsCaught }) => `agrees with ${ heldOut } held-out verdicts, and fails ${ heldOutFailsCaught } of the held-out runs the reviewer failed`,
            },
        ];
    }

    /** The item's status, and why, from the first criterion it meets */
    decide(evidence: ItemEvidence): { status: CalibrationStatus, why: string } {
        const met = this.criteria.find(criterion => criterion.isMet(evidence))!;
        return { status: met.status, why: met.why(evidence) };
    }
}
