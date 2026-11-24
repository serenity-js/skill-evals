// The results of each layout with each agent, and the decision rule, as the evaluation's brief sets it out:
//
// 1. Working code comes first. A layout whose share of correct runs is at least 10 percentage points lower than
//    another layout's, in either agent, can't win against it.
// 2. Among the layouts left, one is better only if its conventions score is at least 10 percentage points higher in
//    both agents, and it loads the right skills at least as often.
// 3. Otherwise it's a tie, and the layout with fewer skills wins. None never wins: it can take a layout out on
//    correctness, and it's the bar for rule 4, but it isn't a candidate for best, or for the tie.
// 4. If no layout does better than None on correctness or on conventions, report that and stop.
//
// Where the brief leaves room, this reads it as follows: rule 1 removes a layout from the running once any other layout
// is that much more often correct; "loads the right skills at least as often" holds in both agents, and doesn't apply
// to None, which has no skills to load; and "does better than None" in rule 4 uses the thresholds of rules 1 and 2:
// correct at least 10 points more often in either agent, or conventions at least 10 points higher in both.
import { allSkillsOf, type Layout, LAYOUTS } from './layouts.ts';
import type { Outcome } from './outcome.ts';
import type { Agent } from './review.ts';
import type { Tokens } from './streams.ts';

export interface RunResult {
    id: string;
    agent: Agent;
    layout: Layout;
    request: string;
    repeat: number;
    /**
     * `correct` when `tsc --noEmit` and `npm test` both passed; `network-failure` when npm test couldn't reach the
     * scenarios' APIs; `agent-failure` when the agent errored or made no tool calls
     */
    outcome: Outcome;
    /** Whether the run read the skills its request needs; `undefined` for the layout without skills */
    loadingRight: boolean | undefined;
    /** The agent didn't finish before the timeout, and was stopped */
    timedOut: boolean;
    conventions: { passed: number, applicable: number };
    tokens: Tokens;
    durationMs: number;
    /** `undefined` when the agent doesn't report a cost */
    costUsd: number | undefined;
    /** Whether the run's stream reports tokens */
    tokensReported: boolean;
    /** The credits the run used, as Kiro reports them; `undefined` for an agent that doesn't */
    credits: number | undefined;
    /** The run's stream didn't say which model it used */
    modelUnreported: boolean;
    /** Every model the run's stream reports, or none */
    models: string[];
}

export interface Share {
    count: number;
    of: number;
}

export interface Stats {
    runs: number;
    /** Of the runs that didn't fail to reach the scenarios' APIs, or fail because the agent did */
    correct: Share;
    networkFailures: number;
    /** Runs whose agent errored or made no tool calls */
    agentFailures: number;
    timeouts: number;
    /** Runs whose stream didn't say which model they used */
    modelUnreported: number;
    conventions: Share;
    conventionsOfCorrect: Share;
    loading: Share | undefined;
    /** `undefined` when none of the runs' streams report tokens, as with Kiro's */
    meanTokens: number | undefined;
    /** `undefined` when any of the runs has no credits, as with an agent that doesn't report them */
    totalCredits: number | undefined;
    meanDurationMs: number;
    /** `undefined` when any of the runs has no cost, as with an agent that doesn't report one */
    totalCostUsd: number | undefined;
    /** The runs by the models each reports, joined with " + " when a run used more than one, and '' for none, as with a pin of "auto" */
    byModel: Record<string, { runs: number, correct: Share }>;
}

export type Summary = Partial<Record<Layout, Partial<Record<Agent, Stats>>>>;

export interface Elimination {
    layout: Layout;
    by: Layout;
    agent: Agent;
    /** How much more often `by` was correct, in percentage points, to one decimal place */
    difference: number;
}

export interface Decision {
    outcome: 'winner' | 'tie' | 'skills-dont-help' | 'no-winner' | 'incomplete' | 'too-small';
    winner: Layout | undefined;
    eliminated: Elimination[];
    reasons: string[];
}

const THRESHOLD = 10;

/**
 * The runs per layout per agent the decision rule was written for: the full evaluation's, every request of
 * requests.json 3 times. With fewer, a difference of THRESHOLD points is noise, so there's no decision.
 */
export const RUNS_PER_LAYOUT_FOR_A_DECISION = 33;

/** The smallest sample, of the runs of a layout with an agent, when it's smaller than the decision rule needs, or `undefined`. */
export function tooSmallToDecide(runsPerLayoutAndAgent: number[]): number | undefined {
    const smallest = Math.min(...runsPerLayoutAndAgent);
    return runsPerLayoutAndAgent.length > 0 && smallest < RUNS_PER_LAYOUT_FOR_A_DECISION ? smallest : undefined;
}

/** "6 runs", or "1 run". */
export const runsCount = (runs: number) => `${ runs } run${ runs === 1 ? '' : 's' }`;
// shares like 9/10 - 8/10 aren't exactly 0.1 in floating point
const EPSILON = 1e-9;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const mean = (values: number[]) => values.length > 0 ? sum(values) / values.length : 0;
const totalTokens = (tokens: Tokens) => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;

function conventionsOf(results: RunResult[]): Share {
    return { count: sum(results.map(result => result.conventions.passed)), of: sum(results.map(result => result.conventions.applicable)) };
}

/** A run says something about its layout unless the APIs were down, or the agent didn't do the work. */
const isJudged = (result: RunResult) => result.outcome !== 'network-failure' && result.outcome !== 'agent-failure';

const mixOf = (result: RunResult) => [ ...result.models ].sort().join(' + ');

function statsOf(results: RunResult[]): Stats {
    // an agent that failed didn't do the work, so its code and the skills it loaded say nothing about the layout
    const worked = results.filter(result => result.outcome !== 'agent-failure');
    const loaded = worked.filter(result => result.loadingRight !== undefined);
    const scored = results.filter(isJudged);
    const correct = results.filter(result => result.outcome === 'correct');
    return {
        runs: results.length,
        correct: { count: correct.length, of: scored.length },
        networkFailures: results.filter(result => result.outcome === 'network-failure').length,
        agentFailures: results.filter(result => result.outcome === 'agent-failure').length,
        timeouts: results.filter(result => result.timedOut).length,
        modelUnreported: results.filter(result => result.modelUnreported).length,
        conventions: conventionsOf(worked),
        conventionsOfCorrect: conventionsOf(correct),
        loading: loaded.length > 0 ? { count: loaded.filter(result => result.loadingRight).length, of: loaded.length } : undefined,
        meanTokens: results.some(result => result.tokensReported) ? mean(results.filter(result => result.tokensReported).map(result => totalTokens(result.tokens))) : undefined,
        totalCredits: results.every(result => result.credits !== undefined) ? sum(results.map(result => result.credits!)) : undefined,
        meanDurationMs: mean(results.map(result => result.durationMs)),
        totalCostUsd: results.every(result => result.costUsd !== undefined) ? sum(results.map(result => result.costUsd!)) : undefined,
        byModel: Object.fromEntries([ ...new Set(results.map(mixOf)) ].sort().map(model => {
            const theirs = results.filter(result => mixOf(result) === model);
            const judged = theirs.filter(isJudged);
            return [ model, { runs: theirs.length, correct: { count: judged.filter(result => result.outcome === 'correct').length, of: judged.length } } ];
        })),
    };
}

export function summarise(results: RunResult[]): Summary {
    const summary: Summary = {};
    for (const layout of LAYOUTS) {
        for (const agent of [ ...new Set(results.map(result => result.agent)) ]) {
            const theirs = results.filter(result => result.layout === layout && result.agent === agent);
            if (theirs.length > 0) {
                (summary[layout] ??= {})[agent] = statsOf(theirs);
            }
        }
    }
    return summary;
}

/** A share in percentage points. */
const points = (share: Share | undefined) => share && share.of > 0 ? 100 * share.count / share.of : 0;
const atLeast = (difference: number, threshold: number) => difference >= threshold - EPSILON;

export function decide(summary: Summary, skillCount: (layout: Layout) => number = layout => allSkillsOf(layout).length): Decision {
    const layouts = LAYOUTS.filter(layout => summary[layout]);
    const agents = [ ...new Set(layouts.flatMap(layout => Object.keys(summary[layout]!) as Agent[])) ];
    const missing = layouts.flatMap(layout => agents.filter(agent => ! summary[layout]?.[agent]).map(agent => `${ layout } with ${ agent }`));
    if (missing.length > 0) {
        return { outcome: 'incomplete', winner: undefined, eliminated: [], reasons: [ `There are no runs of ${ missing.join(', ') } yet, so the layouts can't be compared.` ] };
    }
    // a sample without judged runs, all of them network failures, isn't a correctness of 0%: there's no measure yet
    const unjudged = layouts.flatMap(layout => agents
        .filter(agent => summary[layout]![agent]!.correct.of === 0)
        .map(agent => {
            const { networkFailures, agentFailures } = summary[layout]![agent]!;
            const kind = agentFailures === 0 ? 'network failures' : (networkFailures === 0 ? 'agent failures' : 'network or agent failures');
            return `None of the runs of ${ layout } with ${ agent } could be judged: all ${ networkFailures + agentFailures } were ${ kind }, so the layouts can't be compared yet.`;
        }));
    if (unjudged.length > 0) {
        return { outcome: 'incomplete', winner: undefined, eliminated: [], reasons: unjudged };
    }
    const stats = (layout: Layout, agent: Agent): Stats => summary[layout]![agent]!;
    const correctness = (layout: Layout, agent: Agent) => points(stats(layout, agent).correct);
    const conventions = (layout: Layout, agent: Agent) => points(stats(layout, agent).conventions);
    const loading = (layout: Layout, agent: Agent) => points(stats(layout, agent).loading);

    const moreOftenCorrect = (layout: Layout, than: Layout) => agents.some(agent => atLeast(correctness(layout, agent) - correctness(than, agent), THRESHOLD));
    const betterConventions = (layout: Layout, than: Layout) => agents.every(agent => atLeast(conventions(layout, agent) - conventions(than, agent), THRESHOLD));
    const loadsAsOften = (layout: Layout, than: Layout) =>
        layout === 'none' || than === 'none' || agents.every(agent => loading(layout, agent) >= loading(than, agent) - EPSILON);

    const reasons: string[] = [];

    if (layouts.includes('none')) {
        const helping = layouts.filter(layout => layout !== 'none' && (moreOftenCorrect(layout, 'none') || betterConventions(layout, 'none')));
        if (helping.length === 0) {
            reasons.push('No layout is correct at least 10 percentage points more often than None, in either agent, or scores at least 10 points higher on conventions in both agents: the skills don\'t help as they\'re written, whatever the layout.');
            return { outcome: 'skills-dont-help', winner: undefined, eliminated: [], reasons };
        }
    }

    const eliminated: Elimination[] = layouts.flatMap(layout => layouts.flatMap(by => agents.flatMap(agent => {
        const difference = correctness(by, agent) - correctness(layout, agent);
        return by !== layout && atLeast(difference, THRESHOLD) ? [ { layout, by, agent, difference: Math.round(difference * 10) / 10 } ] : [];
    })));
    for (const { layout, by, agent, difference } of eliminated) {
        reasons.push(`${ layout } can't win: ${ by } is correct ${ difference } percentage points more often with ${ agent }.`);
    }

    // None can take a layout out on correctness, and it's the bar for rule 4, but it never wins
    const candidates = layouts.filter(layout => layout !== 'none' && ! eliminated.some(elimination => elimination.layout === layout));
    if (candidates.length === 0) {
        reasons.push('Every layout with skills is correct at least 10 percentage points less often than another layout, in one of the agents.');
        return { outcome: 'no-winner', winner: undefined, eliminated, reasons };
    }

    const isBetter = (layout: Layout, than: Layout) => betterConventions(layout, than) && loadsAsOften(layout, than);
    const unbeaten = candidates.filter(layout => ! candidates.some(other => other !== layout && isBetter(other, layout)));

    if (unbeaten.length === 1) {
        const [ winner ] = unbeaten;
        const beaten = candidates.filter(other => other !== winner);
        reasons.push(beaten.length > 0
            ? `${ winner } scores at least 10 percentage points higher on conventions than ${ beaten.join(', ') } in every agent, and loads the right skills at least as often.`
            : `${ winner } is the only layout with skills left once correctness is taken into account.`);
        return { outcome: 'winner', winner, eliminated, reasons };
    }

    const winner = [ ...unbeaten ].sort((one, other) => skillCount(one) - skillCount(other))[0];
    reasons.push(`${ unbeaten.join(', ') } tie on conventions; ${ winner }, with ${ skillCount(winner) } skill(s), has the fewest.`);
    return { outcome: 'tie', winner, eliminated, reasons };
}

/**
 * The decision, once every planned run has a result; until then, none, with how many runs are still missing. With an
 * agent, `planned` and `scored` count that agent's runs only, and the reason says so.
 */
export function decideWhenComplete(summary: Summary, { planned, scored, agent }: { planned: number, scored: number, agent?: Agent }): Decision {
    if (scored < planned) {
        return { outcome: 'incomplete', winner: undefined, eliminated: [], reasons: [ `${ planned - scored } of the ${ planned } planned runs${ agent ? ` of ${ agent }` : '' } have no result yet, so there's no decision.` ] };
    }
    // a complete pilot is still too small for the rule, which was written for the full evaluation's sample
    const smallest = tooSmallToDecide(LAYOUTS.flatMap(layout => Object.values(summary[layout] ?? {}).map(stats => stats!.runs)));
    if (smallest !== undefined) {
        return { outcome: 'too-small', winner: undefined, eliminated: [], reasons: [
            `${ runsCount(smallest) } per layout per agent, and the decision rule needs ${ RUNS_PER_LAYOUT_FOR_A_DECISION }: in a sample this small, one run is worth ${ Math.round(100 / smallest) } percentage points, so the differences are noise. The counts and percentages above still show what happened.`,
        ] };
    }
    return decide(summary);
}

const HEADLINES: Record<Decision['outcome'], (winner: Layout | undefined) => string> = {
    'winner': winner => `**Winner: ${ winner }**`,
    'tie': winner => `**Tie, won by ${ winner }, with the fewest skills**`,
    'skills-dont-help': () => '**The skills don\'t help as they\'re written, whatever the layout.**',
    'no-winner': () => '**No winner: every layout with skills is taken out on correctness.**',
    'incomplete': () => '**No decision yet.**',
    'too-small': () => '**Too small to decide.**',
};

function share(value: Share | undefined): string {
    return value ? `${ value.count }/${ value.of } (${ Math.round(points(value)) }%)` : 'n/a';
}

export function renderSummary(summary: Summary, decision: Decision): string {
    const rows = LAYOUTS.flatMap(layout => Object.entries(summary[layout] ?? {}).map(([ agent, stats ]) =>
        `| ${ layout } | ${ agent } | ${ stats.runs } | ${ share(stats.correct) } | ${ stats.networkFailures } | ${ stats.agentFailures } | ${ stats.timeouts } | ${ stats.modelUnreported } | ${ share(stats.conventions) } | ${ share(stats.conventionsOfCorrect) } | ${ share(stats.loading) } | ${ stats.meanTokens === undefined ? 'n/a' : Math.round(stats.meanTokens) } | ${ Math.round(stats.meanDurationMs / 1000) } s | ${ stats.totalCredits === undefined ? 'n/a' : stats.totalCredits.toFixed(2) } | ${ stats.totalCostUsd === undefined ? 'n/a' : `$${ stats.totalCostUsd.toFixed(2) }` } |`));

    return [
        '# Skill layouts: results',
        '',
        '| Layout | Agent | Runs | Correct | Network failures | Agent failures | Timeouts | Model unreported | Conventions | Conventions, correct runs | Loaded the right skills | Mean tokens | Mean time | Credits | Cost |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
        ...rows,
        '',
        '## Models',
        '',
        'The models each run reports. With a pin, every run reports the pinned model; with "auto", whichever the agent picked, and a run that used several is listed under the mix, joined with +.',
        '',
        '| Layout | Agent | Model | Runs | Correct |',
        '|---|---|---|---|---|',
        ...LAYOUTS.flatMap(layout => Object.entries(summary[layout] ?? {}).flatMap(([ agent, stats ]) =>
            Object.entries(stats.byModel).map(([ model, { runs, correct } ]) => `| ${ layout } | ${ agent } | ${ model || '(not reported)' } | ${ runs } | ${ share(correct) } |`))),
        '',
        '## Decision',
        '',
        HEADLINES[decision.outcome](decision.winner),
        '',
        ...decision.reasons.map(reason => `- ${ reason }`),
        '',
        `With ${ RUNS_PER_LAYOUT_FOR_A_DECISION } runs per layout per agent, differences under ${ THRESHOLD } percentage points are noise.`
            + ' Runs whose `npm test` couldn\'t reach the scenarios\' APIs are left out of the correctness rate, and counted under network failures; so are runs whose agent errored or made no tool calls, counted under agent failures.',
        '',
    ].join('\n');
}
