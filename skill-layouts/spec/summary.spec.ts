import { describe, expect, it } from 'vitest';

import type { Layout } from '../src/layouts.ts';
import type { Agent } from '../src/review.ts';
import { decide, decideWhenComplete, renderSummary, RUNS_PER_LAYOUT_FOR_A_DECISION, type RunResult, summarise } from '../src/summary.ts';

interface Profile {
    /** correct runs, out of `of` */
    correct: number;
    /** conventions items passed, out of 10 per run */
    conventions?: number;
    /** runs that loaded the right skills */
    loaded?: number;
    /** runs after the correct ones whose npm test failed to reach the scenarios' APIs */
    networkFailures?: number;
    /** runs after those whose agent errored or made no tool calls */
    agentFailures?: number;
    /** runs the agent didn't finish before the timeout */
    timeouts?: number;
    /** runs whose stream didn't say which model they used */
    modelUnreported?: number;
    /** the models the runs report, in turn, as with a pin of "auto" */
    models?: string[];
    of?: number;
}

/** `of` runs of a layout with an agent: the first `correct` are correct, each passes `conventions` of 10 items. */
function runs(layout: Layout, agent: Agent, { correct, conventions = 5, loaded, networkFailures = 0, agentFailures = 0, timeouts = 0, modelUnreported = 0, models, of = 24 }: Profile): RunResult[] {
    return Array.from({ length: of }, (_, index) => ({
        id: `${ layout }-${ agent }-${ index }`,
        agent,
        layout,
        request: `request-${ index % 8 }`,
        repeat: Math.floor(index / 8) + 1,
        outcome: index < correct ? 'correct' : (index < correct + networkFailures ? 'network-failure' : (index < correct + networkFailures + agentFailures ? 'agent-failure' : 'incorrect')),
        loadingRight: layout === 'none' ? undefined : index < (loaded ?? of),
        timedOut: index < timeouts,
        conventions: { passed: conventions, applicable: 10 },
        tokens: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 },
        durationMs: 60_000,
        // as the agents report them: Kiro credits, without tokens; Copilot tokens, without credits; neither a cost
        costUsd: undefined,
        tokensReported: agent === 'copilot',
        credits: agent === 'kiro' ? 0.75 : undefined,
        modelUnreported: index < modelUnreported,
        models: index < modelUnreported ? [] : [ models?.[index % models.length] ?? 'claude-sonnet-5.5' ],
    }));
}

const both = (layout: Layout, kiro: Profile, copilot: Profile = kiro) => [ ...runs(layout, 'kiro', kiro), ...runs(layout, 'copilot', copilot) ];

describe('summarise', () => {

    const summary = summarise([
        ...runs('b', 'kiro', { correct: 18, conventions: 6, loaded: 12 }),
        ...runs('none', 'kiro', { correct: 12 }),
    ]);

    it('reports the counts behind every share', () => {
        expect(summary.b?.kiro?.correct).toEqual({ count: 18, of: 24 });
        expect(summary.b?.kiro?.conventions).toEqual({ count: 144, of: 240 });
        expect(summary.b?.kiro?.loading).toEqual({ count: 12, of: 24 });
    });

    it("leaves runs whose npm test couldn't reach the scenarios' APIs out of the correctness rate, and counts them", () => {
        const withFailures = summarise(runs('b', 'kiro', { correct: 18, networkFailures: 4 }));

        expect(withFailures.b?.kiro?.correct).toEqual({ count: 18, of: 20 });
        expect(withFailures.b?.kiro?.networkFailures).toBe(4);
        expect(withFailures.b?.kiro?.conventions.of).toBe(240);
    });

    it("leaves runs whose agent errored or made no tool calls out of the correctness rate too, and counts them apart from the network failures", () => {
        const withFailures = summarise(runs('b', 'copilot', { correct: 12, networkFailures: 2, agentFailures: 4 }));

        expect(withFailures.b?.copilot).toMatchObject({ correct: { count: 12, of: 18 }, networkFailures: 2, agentFailures: 4 });
        // the network failures' code still counts, as before; an agent failure's doesn't, since the agent didn't do the work
        expect(withFailures.b?.copilot?.conventions.of).toBe(200);
        expect(withFailures.b?.copilot?.loading).toEqual({ count: 20, of: 20 });
        expect(withFailures.b?.copilot?.byModel['claude-sonnet-5.5']?.correct).toEqual({ count: 12, of: 18 });
        expect(renderSummary(withFailures, decide(withFailures))).toContain('| Agent failures |');
        expect(renderSummary(withFailures, decide(withFailures))).toMatch(/^\| b \| copilot \| 24 \| 12\/18 \(67%\) \| 2 \| 4 \|/m);
    });

    it("doesn't decide on layouts whose runs all failed for the agent's reasons, and says so", () => {
        const failed = summarise(both('b', { correct: 20 }, { correct: 0, agentFailures: 24 }));

        expect(decide(failed)).toMatchObject({ outcome: 'incomplete', reasons: [ "None of the runs of b with copilot could be judged: all 24 were agent failures, so the layouts can't be compared yet." ] });
    });

    it("breaks the results down by the mix of models each run used, when it used more than one", () => {
        const mixed = summarise(runs('b', 'copilot', { correct: 12, models: [ 'claude-sonnet-5.5', 'claude-sonnet-5.5 + gpt-6' ] }).map((run, index) => index % 2 === 1 ? { ...run, models: [ 'claude-sonnet-5.5', 'gpt-6' ] } : run));

        expect(Object.keys(mixed.b!.copilot!.byModel)).toEqual([ 'claude-sonnet-5.5', 'claude-sonnet-5.5 + gpt-6' ]);
    });

    it("counts the runs the agent didn't finish before the timeout", () => {
        expect(summarise(runs('b', 'kiro', { correct: 18, timeouts: 3 })).b?.kiro?.timeouts).toBe(3);
    });

    it("counts the runs whose stream didn't say which model they used", () => {
        expect(summarise(runs('b', 'kiro', { correct: 18, modelUnreported: 2 })).b?.kiro?.modelUnreported).toBe(2);
    });

    it("shows n/a for what an agent doesn't report: Kiro's tokens, Copilot's credits, and either's cost", () => {
        const both = summarise([ ...runs('b', 'kiro', { correct: 18 }), ...runs('b', 'copilot', { correct: 18 }) ]);
        const rendered = renderSummary(both, decide(both));

        expect(rendered).toContain('| Mean tokens | Mean time | Credits | Cost |');
        expect(rendered).toMatch(/^\| b \| kiro \|.*\| n\/a \| 60 s \| 18\.00 \| n\/a \|$/m);
        expect(rendered).toMatch(/^\| b \| copilot \|.*\| 1100 \| 60 s \| n\/a \| n\/a \|$/m);
    });

    it('breaks the results down by the model each run reports, as with a pin of "auto"', () => {
        const auto = summarise(runs('b', 'copilot', { correct: 12, models: [ 'claude-sonnet-5.5', 'gpt-6' ], modelUnreported: 2 }));

        expect(auto.b?.copilot?.byModel).toEqual({
            '': { runs: 2, correct: { count: 2, of: 2 } },
            'claude-sonnet-5.5': { runs: 11, correct: { count: 5, of: 11 } },
            'gpt-6': { runs: 11, correct: { count: 5, of: 11 } },
        });
        expect(renderSummary(auto, decide(auto))).toContain('| b | copilot | gpt-6 | 11 | 5/11 (45%) |');
        expect(renderSummary(auto, decide(auto))).toContain('| b | copilot | (not reported) | 2 | 2/2 (100%) |');
    });

    it('reports conventions for the correct runs on their own', () => {
        expect(summary.b?.kiro?.conventionsOfCorrect).toEqual({ count: 108, of: 180 });
    });

    it("doesn't report loading for the layout without skills", () => {
        expect(summary.none?.kiro?.loading).toBeUndefined();
    });

    it('reports the cost: the credits Kiro used, and no tokens or dollars, which it reports none of', () => {
        expect(summary.b?.kiro?.totalCredits).toBe(18);
        expect(summary.b?.kiro?.meanTokens).toBeUndefined();
        expect(summary.b?.kiro?.meanDurationMs).toBe(60_000);
        expect(summary.b?.kiro?.totalCostUsd).toBeUndefined();
    });

    it("reports the tokens of Copilot's runs, and no credits", () => {
        const copilot = summarise(runs('b', 'copilot', { correct: 18 }));

        expect(copilot.b?.copilot?.meanTokens).toBe(1100);
        expect(copilot.b?.copilot?.totalCredits).toBeUndefined();
    });

    it('renders the shares with their counts', () => {
        expect(renderSummary(summary, decide(summary))).toContain('| b | kiro | 24 | 18/24 (75%) | 0 | 0 | 0 | 0 | 144/240 (60%) | 108/180 (60%) | 12/24 (50%) |');
    });

    it("says how many runs each layout gets with each agent, in the full evaluation: 11 requests, 3 times", () => {
        expect(renderSummary(summary, decide(summary))).toContain('With 33 runs per layout per agent, differences under 10 percentage points are noise.');
    });
});

describe('decide', () => {

    it("doesn't let a layout win whose share of correct runs is 10 percentage points lower than another's, in either agent, however good its conventions", () => {
        const decision = decide(summarise([
            ...both('none', { correct: 12 }),
            ...both('a', { correct: 20 }),
            ...both('b', { correct: 20 }),
            ...both('c', { correct: 20, conventions: 9 }, { correct: 17, conventions: 9 }),
        ]));

        expect(decision.eliminated).toEqual(expect.arrayContaining([
            { layout: 'c', by: 'a', agent: 'copilot', difference: 12.5 },
            { layout: 'none', by: 'a', agent: 'kiro', difference: 33.3 },
        ]));
        expect(decision.outcome).toBe('tie');
        expect(decision.winner).toBe('b');
    });

    it('counts a difference of exactly 10 percentage points', () => {
        const decision = decide(summarise([
            ...both('none', { correct: 2, of: 10 }),
            ...both('a', { correct: 9, of: 10 }),
            ...both('b', { correct: 8, of: 10 }),
        ]));

        expect(decision.eliminated).toContainEqual({ layout: 'b', by: 'a', agent: 'kiro', difference: 10 });
        expect(decision.winner).toBe('a');
    });

    it('treats smaller differences in correctness as noise', () => {
        const decision = decide(summarise([
            ...both('none', { correct: 10 }),
            ...both('a', { correct: 20 }),
            ...both('b', { correct: 18 }),
        ]));

        expect(new Set(decision.eliminated.map(elimination => elimination.layout))).toEqual(new Set([ 'none' ]));
    });

    it('never lets None win, though it can still take a layout out on correctness', () => {
        const decision = decide(summarise([
            ...both('none', { correct: 20, conventions: 5 }),
            ...both('a', { correct: 18, conventions: 8 }),
            ...both('b', { correct: 22, conventions: 5 }),
        ]));

        expect(decision.eliminated).toContainEqual({ layout: 'a', by: 'b', agent: 'kiro', difference: 16.7 });
        expect(decision.outcome).toBe('winner');
        expect(decision.winner).toBe('b');
    });

    it('reports the only layout with skills left as the winner, not as a tie, when None is left too', () => {
        const decision = decide(summarise([
            ...both('none', { correct: 20, conventions: 5 }),
            ...both('a', { correct: 20, conventions: 5 }),
            ...both('b', { correct: 17, conventions: 8 }),
        ]));

        expect(decision.outcome).toBe('winner');
        expect(decision.winner).toBe('a');
        expect(decision.reasons.join(' ')).not.toMatch(/tie/);
    });

    it("has no winner, rather than failing, when the agents favour opposite layouts and every layout is taken out", () => {
        const decision = decide(summarise([
            ...both('none', { correct: 12 }),
            ...both('a', { correct: 24 }, { correct: 12 }),
            ...both('b', { correct: 12 }, { correct: 24 }),
            ...both('c', { correct: 12 }),
        ]));

        expect(new Set(decision.eliminated.map(elimination => elimination.layout))).toEqual(new Set([ 'none', 'a', 'b', 'c' ]));
        expect(decision.outcome).toBe('no-winner');
        expect(decision.winner).toBeUndefined();
    });

    it("withholds the decision, rather than eliminating a layout, when none of its runs with an agent could be judged", () => {
        const decision = decide(summarise([
            ...both('none', { correct: 10 }),
            ...both('a', { correct: 20 }),
            ...both('b', { correct: 20 }, { correct: 0, networkFailures: 24 }),
        ]));

        expect(decision).toEqual({
            outcome: 'incomplete',
            winner: undefined,
            eliminated: [],
            reasons: [ "None of the runs of b with copilot could be judged: all 24 were network failures, so the layouts can't be compared yet." ],
        });
    });

    it('has no winner when None takes every layout with skills out on correctness', () => {
        const decision = decide(summarise([
            ...both('none', { correct: 22, conventions: 5 }),
            ...both('a', { correct: 18, conventions: 8 }),
        ]));

        expect(decision.outcome).toBe('no-winner');
        expect(decision.winner).toBeUndefined();
    });

    it('picks a layout whose conventions score is 10 percentage points higher in both agents, and that loads the right skills at least as often', () => {
        const decision = decide(summarise([
            ...both('none', { correct: 10 }),
            ...both('a', { correct: 20, conventions: 7, loaded: 20 }),
            ...both('b', { correct: 20, conventions: 5, loaded: 20 }),
        ]));

        expect(decision.outcome).toBe('winner');
        expect(decision.winner).toBe('a');
    });

    it("calls it a tie when the conventions score is only higher in one agent, and the layout with fewer skills wins", () => {
        const decision = decide(summarise([
            ...both('none', { correct: 10 }),
            ...both('a', { correct: 20, conventions: 7 }, { correct: 20, conventions: 5 }),
            ...both('b', { correct: 20, conventions: 5 }),
        ]));

        expect(decision.outcome).toBe('tie');
        expect(decision.winner).toBe('b');
    });

    it('calls it a tie when the layout with better conventions loads the right skills less often', () => {
        const decision = decide(summarise([
            ...both('none', { correct: 10 }),
            ...both('a', { correct: 20, conventions: 7, loaded: 20 }, { correct: 20, conventions: 7, loaded: 19 }),
            ...both('b', { correct: 20, conventions: 5, loaded: 20 }),
        ]));

        expect(decision.outcome).toBe('tie');
        expect(decision.winner).toBe('b');
    });

    it("stops when no layout does better than None on correctness or on conventions", () => {
        const decision = decide(summarise([
            ...both('none', { correct: 18, conventions: 5 }),
            ...both('a', { correct: 20, conventions: 5 }),
            ...both('b', { correct: 19, conventions: 5 }),
        ]));

        expect(decision.outcome).toBe('skills-dont-help');
        expect(decision.winner).toBeUndefined();
    });

    it("doesn't decide while a layout has no runs with one of the agents, as during an evaluation", () => {
        const decision = decide(summarise([
            ...both('none', { correct: 10 }),
            ...runs('a', 'copilot', { correct: 20 }),
        ]));

        expect(decision).toEqual({ outcome: 'incomplete', winner: undefined, eliminated: [], reasons: [ 'There are no runs of a with kiro yet, so the layouts can\'t be compared.' ] });
    });

    it('counts a layout as doing better than None on conventions only when it does in both agents', () => {
        const decision = decide(summarise([
            ...both('none', { correct: 20, conventions: 5 }),
            ...both('b', { correct: 20, conventions: 7 }, { correct: 20, conventions: 5 }),
        ]));

        expect(decision.outcome).toBe('skills-dont-help');
    });
});

describe('decideWhenComplete', () => {

    // a complete full evaluation: as many runs per layout per agent as the decision rule needs
    const results = [ ...both('none', { correct: 14, of: 33 }), ...both('a', { correct: 28, of: 33 }) ];

    it('withholds the decision until every planned run has a result, and says how many are missing', () => {
        expect(decideWhenComplete(summarise(results), { planned: results.length + 5, scored: results.length })).toEqual({
            outcome: 'incomplete',
            winner: undefined,
            eliminated: [],
            reasons: [ `5 of the ${ results.length + 5 } planned runs have no result yet, so there's no decision.` ],
        });
    });

    it('decides once every planned run has a result', () => {
        expect(decideWhenComplete(summarise(results), { planned: results.length, scored: results.length }).winner).toBe('a');
    });

    it('needs 33 runs per layout per agent, the sample the rule was written for', () => {
        expect(RUNS_PER_LAYOUT_FOR_A_DECISION).toBe(33);
    });

    describe('for a complete pilot with fewer runs per layout than the rule needs', () => {

        // the Copilot check's shape: 6 runs of each of b and c, which the rule alone would decide on
        const pilot = [ ...runs('b', 'copilot', { correct: 2, of: 6 }), ...runs('c', 'copilot', { correct: 5, of: 6 }) ];
        const decision = decideWhenComplete(summarise(pilot), { planned: pilot.length, scored: pilot.length, agent: 'copilot' });

        it("names no winner, and says the pilot is too small to decide, with the runs it has and those the rule needs", () => {
            expect(decide(summarise(pilot)).winner).toBe('c');
            expect(decision).toEqual({
                outcome: 'too-small',
                winner: undefined,
                eliminated: [],
                reasons: [ "6 runs per layout per agent, and the decision rule needs 33: in a sample this small, one run is worth 17 percentage points, so the differences are noise. The counts and percentages above still show what happened." ],
            });
        });

        it("says so in summary.md, with the counts and percentages as they are", () => {
            const rendered = renderSummary(summarise(pilot), decision);

            expect(rendered).toContain('**Too small to decide.**');
            expect(rendered).not.toContain('Winner');
            expect(rendered).toContain('| c | copilot | 6 | 5/6 (83%) |');
        });

        it('goes by the smallest sample, when the layouts have different numbers of runs', () => {
            const uneven = [ ...runs('b', 'copilot', { correct: 30, of: 40 }), ...runs('c', 'copilot', { correct: 5, of: 6 }) ];

            expect(decideWhenComplete(summarise(uneven), { planned: uneven.length, scored: uneven.length }).reasons[0])
                .toMatch(/^6 runs per layout per agent, and the decision rule needs 33/);
        });
    });

    it("says how many runs per layout the 10-point rule is for, from the same number", () => {
        expect(renderSummary(summarise(results), decide(summarise(results)))).toContain(`With ${ RUNS_PER_LAYOUT_FOR_A_DECISION } runs per layout per agent, differences under 10 percentage points are noise.`);
    });
});
