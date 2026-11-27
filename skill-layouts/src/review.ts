// Blind review: every run gets a random ID, and the reviewer scores each run's diff against the conventions
// checklist without seeing which layout, or which agent, produced it. The mapping from IDs to runs is kept apart,
// in mapping.json, outside the review directory.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { CHECKLIST, type Check, type ChecklistItem, exercises, type Verdict } from './conventions.ts';
import { evalRoot, type Layout } from './layouts.ts';

const checklistLine = (item: typeof CHECKLIST[number]) =>
    `- [ ] ${ item.id }: ${ item.text }${ item.scoredBy === 'reviewer' ? ' (reviewer only: the AST patterns leave it n/a)' : '' }`;

/** The rules the decisions made so far give the reviewer, each with the run it was made on */
export const REVIEW_GUIDE = join(evalRoot, 'review-guide.md');

import { type Agent } from './agents/index.ts';

export { AGENTS, type Agent } from './agents/index.ts';

export interface RunKey {
    agent: Agent;
    layout: Layout;
    request: string;
    repeat: number;
}

export interface PlannedRun extends RunKey {
    id: string;
}

export type ReviewScores = Record<string, Partial<Record<ChecklistItem, string>>>;

function shuffled<T>(items: T[]): T[] {
    const copy = [ ...items ];
    for (let index = copy.length - 1; index > 0; index--) {
        const other = randomBytes(4).readUInt32BE() % (index + 1);
        [ copy[index], copy[other] ] = [ copy[other], copy[index] ];
    }
    return copy;
}

/** The runs, each with a random ID, in random order. */
export function planRuns(
    keys: RunKey[],
    { randomId = () => randomBytes(4).toString('hex'), shuffle = shuffled }: { randomId?: () => string, shuffle?: <T>(items: T[]) => T[] } = {},
): PlannedRun[] {
    const taken = new Set<string>();
    const nextId = () => {
        let id = randomId();
        while (taken.has(id)) {
            id = randomId();
        }
        taken.add(id);
        return id;
    };
    return shuffle(keys).map(key => ({ ...key, id: nextId() }));
}

const SKILL_PATH = /(?:(?:\.kiro|\.claude|\.agents|\.github)\/skills|node_modules\/@serenity-js\/[\w-]+\/skills)\/[\w./-]*/g;
const SKILL_NAME = /\bserenity-js-[\da-z-]+/g;

/** The diff with the paths and names of skills hidden, since they'd tell the reviewer the layout. */
function blinded(text: string): string {
    return text.replace(SKILL_PATH, '[skill file]').replace(SKILL_NAME, '[skill]');
}

/**
 * What the reviewer sees of a run: its ID, the request, the diff, and the checklist: the items its request exercises
 * first, then the others, which apply wherever the code the run added is about them.
 */
export function reviewPacket({ id, request, prompt, diff, reply }: { id: string, request: string, prompt: string, diff: string, reply: string }): string {
    return [
        `# Run ${ id }`,
        '',
        '## Request',
        '',
        blinded(prompt),
        '',
        '## Checklist',
        '',
        'Score each item in review/scores.json as pass, fail or n/a, for the code the run added or changed.',
        'An item is n/a when the code the run added has nothing it applies to.',
        `Score them as [the reviewer guide](${ REVIEW_GUIDE }) says: it has a rule for each decision made so far, with the run it was made on.`,
        '',
        '### The items the request exercises',
        '',
        ...CHECKLIST.filter(item => exercises(request, item.id)).map(checklistLine),
        '',
        '### The other items',
        '',
        ...CHECKLIST.filter(item => ! exercises(request, item.id)).map(checklistLine),
        '',
        '## Diff',
        '',
        '```diff',
        blinded(diff),
        '```',
        '',
        // where the agent reports what it did, and suggests what it didn't change
        "## The agent's reply",
        '',
        blinded(reply) || '(none: the agent said nothing after its last tool call)',
        '',
    ].join('\n');
}

/** The file the reviewer fills in: a blank verdict for every item of every run. */
export function scoresTemplate(runs: Array<{ id: string }>): ReviewScores {
    return Object.fromEntries([ ...runs ].sort((one, other) => one.id.localeCompare(other.id)).map(({ id }) =>
        [ id, Object.fromEntries(CHECKLIST.map(item => [ item.id, '' ])) ]));
}

function asVerdict(value: string | undefined, item: string): Verdict | undefined {
    if (value === undefined || value === '') {
        return undefined;
    }
    if (value === 'pass' || value === 'fail' || value === 'n/a') {
        return value;
    }
    throw new Error(`the review of ${ item } says "${ value }", but a verdict is pass, fail or n/a`);
}

/**
 * The verdict on each item: the reviewer's, for every item they scored, and the patterns' for the rest, whether or not
 * the run's request exercises it. The reviewer sees what the patterns can't, such as a task named after the user
 * interface, or a pattern's false alarm.
 */
export function combineVerdicts(ast: Check[], review: Partial<Record<ChecklistItem, string>> | undefined): Array<{ item: ChecklistItem, verdict: Verdict }> {
    return ast.map(({ item, verdict }) => ({ item, verdict: asVerdict(review?.[item], item) ?? verdict }));
}

const REVIEWERS_ONLY = new Set<ChecklistItem>(CHECKLIST.filter(item => item.scoredBy === 'reviewer').map(item => item.id));

/**
 * How many of the patterns' items of a run the reviewer scored, and on how many of those they disagree with the
 * patterns. The reviewer's own items don't count: the patterns always leave them n/a, so there's nothing to disagree with.
 */
export function disagreements(ast: Check[], review: Partial<Record<ChecklistItem, string>> | undefined): { scored: number, disagreed: number } {
    const scored = ast.filter(({ item }) => ! REVIEWERS_ONLY.has(item)).flatMap(({ item, verdict }) => {
        const reviewed = asVerdict(review?.[item], item);
        return reviewed ? [ reviewed !== verdict ] : [];
    });
    return { scored: scored.length, disagreed: scored.filter(Boolean).length };
}
