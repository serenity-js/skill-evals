import type { Verdict as VerdictName } from '../conventions.ts';
import { asVerdict } from '../review.ts';

export type { VerdictName };

/** A verdict on a rule: pass, fail or n/a, whether the patterns, the reviewer or the judge gives it. */
export class Verdict {

    static readonly pass = new Verdict('pass');
    static readonly fail = new Verdict('fail');
    static readonly notApplicable = new Verdict('n/a');

    /** Every verdict, in the order the reports list them */
    static readonly all: readonly Verdict[] = [ Verdict.pass, Verdict.fail, Verdict.notApplicable ];
    static readonly names: readonly VerdictName[] = Verdict.all.map(verdict => verdict.name);

    static of(name: VerdictName): Verdict {
        return Verdict.all.find(verdict => verdict.name === name)!;
    }

    /** The reviewer's verdict in scores.json, undefined while it's blank; anything other than pass, fail or n/a is refused, naming `what` */
    static fromReview(value: string | undefined, what: string): Verdict | undefined {
        const name = asVerdict(value, what);
        return name === undefined ? undefined : Verdict.of(name);
    }

    readonly name: VerdictName;

    private constructor(name: VerdictName) {
        this.name = name;
    }

    /** Whether the code had anything the rule applies to */
    isApplicable(): boolean {
        return this !== Verdict.notApplicable;
    }

    toString(): VerdictName {
        return this.name;
    }

    toJSON(): VerdictName {
        return this.name;
    }
}
