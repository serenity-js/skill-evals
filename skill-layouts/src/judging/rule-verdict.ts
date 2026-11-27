// The judge's verdicts.json, read with the same field-by-field validation as the harness's other files, in records.ts,
// so that a malformed entry is reported as one in a result.json would be: by its path in the file. Unlike the harness's
// own files, it's lenient in one way, about the judge's evidence: see aLineOrLines.
import { aString, type Check, expecting, fields, listOf, oneOf, parseJson, validated } from '../records.ts';
import { Verdict, type VerdictName } from './verdict.ts';

/** What the judge decides about one rule, and why. */
export class RuleVerdict {

    static of(rule: string, verdict: Verdict, evidence: readonly string[], reason: string): RuleVerdict {
        return new RuleVerdict(rule, verdict, evidence, reason);
    }

    static fromJSON(json: { rule: string, verdict: VerdictName, evidence: readonly string[], reason: string }): RuleVerdict {
        return new RuleVerdict(json.rule, Verdict.of(json.verdict), json.evidence, json.reason);
    }

    readonly rule: string;
    readonly verdict: Verdict;
    /** The lines the verdict rests on, as `after/<path>:<line>: <code>`, or `reply.md`; none only for n/a */
    readonly evidence: readonly string[];
    readonly reason: string;

    private constructor(rule: string, verdict: Verdict, evidence: readonly string[], reason: string) {
        this.rule = rule;
        this.verdict = verdict;
        this.evidence = evidence;
        this.reason = reason;
    }

    /** As the judge's reasons are listed: `fail: <reason>` */
    toString(): string {
        return `${ this.verdict.name }: ${ this.reason }`;
    }

    toJSON(): { rule: string, verdict: VerdictName, evidence: readonly string[], reason: string } {
        return { rule: this.rule, verdict: this.verdict.name, evidence: this.evidence, reason: this.reason };
    }
}

const aReason = expecting("a reason that isn't blank", value => typeof value === 'string' && value.trim() !== '');

/**
 * The judge's evidence: a list of lines, or one line, which the judge often gives instead of a list of one. Reading it
 * as that list, rather than retrying the session, is a leniency for the judge's output only; the files the harness
 * writes itself are read as strictly as their schema says.
 */
const aLineOrLines: Check = (value, path, file) => (typeof value === 'string' ? aString : listOf(aString))(value, path, file);

/** Evidence as a list of lines: one line, as a list of it, or none, when the line is blank */
const asLines = (evidence: string | string[]): string[] =>
    typeof evidence !== 'string' ? evidence : evidence.trim() === '' ? [] : [ evidence ];

/** A verdicts.json, as the judge left it: one verdict for every rule, or what's wrong with it. */
export class JudgeVerdicts {

    /** Reads `text`, the contents of `file`, or undefined when the judge left none, as the verdicts on `rules`. */
    static read(text: string | undefined, rules: readonly string[], file: string): JudgeVerdicts {
        if (text === undefined) {
            return new JudgeVerdicts(undefined, [ `there's no ${ file }` ]);
        }
        let parsed: { verdicts: Array<{ rule: string, verdict: VerdictName, evidence: string | string[], reason: string }> };
        try {
            parsed = validated(parseJson(text, file), fields({
                verdicts: listOf(fields({ rule: oneOf(rules), verdict: oneOf(Verdict.names), evidence: aLineOrLines, reason: aReason })),
            }), file);
        }
        catch (error) {
            return new JudgeVerdicts(undefined, [ (error as Error).message ]);
        }
        const verdicts = parsed.verdicts.map(entry => RuleVerdict.fromJSON({ ...entry, evidence: asLines(entry.evidence) }));
        const problems = [
            ...verdicts.flatMap((verdict, index) => {
                const first = verdicts.findIndex(other => other.rule === verdict.rule);
                return first < index ? [ `${ file }: verdicts[${ index }].rule is "${ verdict.rule }", which verdicts[${ first }] scored already` ] : [];
            }),
            ...verdicts.flatMap((verdict, index) => verdict.verdict.isApplicable() && verdict.evidence.length === 0
                ? [ `${ file }: verdicts[${ index }].evidence is empty, but a ${ verdict.verdict.name } needs the lines it rests on` ]
                : []),
            ...rules.filter(rule => ! verdicts.some(verdict => verdict.rule === rule)).map(rule => `${ file }: verdicts has no verdict for ${ rule }`),
        ];
        return problems.length > 0
            ? new JudgeVerdicts(undefined, problems)
            : new JudgeVerdicts(rules.map(rule => verdicts.find(verdict => verdict.rule === rule)!), []);
    }

    /** One per rule, in the rules' order, when the file is usable */
    readonly verdicts: readonly RuleVerdict[] | undefined;
    readonly problems: readonly string[];

    private constructor(verdicts: readonly RuleVerdict[] | undefined, problems: readonly string[]) {
        this.verdicts = verdicts;
        this.problems = problems;
    }

    isUsable(): boolean {
        return this.verdicts !== undefined;
    }
}
