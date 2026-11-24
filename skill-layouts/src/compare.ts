// What --compare writes: compare.md, a section per request that sets the layouts' runs side by side, so that a pilot's
// results can be read before there's enough of them for the decision rule. It only reads the results.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHECKLIST, type ChecklistItem, exercises, type Verdict } from './conventions.ts';
import { LAYOUTS } from './layouts.ts';
import { readPlan, readRecord, readScores } from './records.ts';
import { type Agent, AGENTS, type PlannedRun, type ReviewScores } from './review.ts';
import { modelsOf, type RunRecord } from './runs.ts';
import { RUNS_PER_LAYOUT_FOR_A_DECISION, runsCount, tooSmallToDecide } from './summary.ts';

interface Scored {
    run: PlannedRun;
    record: RunRecord;
}

const NO_REPLY = '(none: the agent said nothing after its last tool call)';

const readIf = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : undefined;

const share = (count: number, of: number) => `${ count } of ${ of }`;

/** A run's verdict on an item: the reviewer's, where they gave one, else the patterns'. */
function verdictOf(scored: Scored, item: ChecklistItem, scores: ReviewScores): Verdict {
    const reviewed = scores[scored.run.id]?.[item];
    if (reviewed === 'pass' || reviewed === 'fail' || reviewed === 'n/a') {
        return reviewed;
    }
    return scored.record.checks.find(check => check.item === item)?.verdict ?? 'n/a';
}

/** A Markdown table: the header row, and a row per entry, with a cell per layout. */
function table(header: string, layouts: string[], rows: Array<[ string, string[] ]>): string[] {
    return [
        `|${ header ? ` ${ header } ` : ' ' }| ${ layouts.join(' | ') } |`,
        `|---|${ layouts.map(() => '---').join('|') }|`,
        ...rows.map(([ label, cells ]) => `| ${ label } | ${ cells.join(' | ') } |`),
    ];
}

/** The models a layout's runs used, each with the runs that used it, or '(not reported)' for the runs whose stream names none. */
function modelCell(runs: Scored[], modelsOfRun: (record: RunRecord) => string[] = modelsOf): string {
    const used = runs.map(({ record }) => modelsOfRun(record));
    const names = [ ...new Set(used.flat()) ].sort();
    const lines = [
        ...names.map(name => `${ name }: ${ share(used.filter(models => models.includes(name)).length, runs.length) }`),
        ...(used.some(models => models.length === 0) ? [ `(not reported): ${ share(used.filter(models => models.length === 0).length, runs.length) }` ] : []),
    ];
    return lines.length > 0 ? lines.join('<br>') : 'n/a';
}

const AGENT_ORDER = [ 'kiro', 'copilot' ];

/** The run shown for a layout: its first repeat with a result, Kiro's before Copilot's. */
function shownRunOf(scored: Scored[]): Scored | undefined {
    return [ ...scored ].sort((one, other) =>
        one.run.repeat - other.run.repeat
        || AGENT_ORDER.indexOf(one.run.agent) - AGENT_ORDER.indexOf(other.run.agent)
        || one.run.id.localeCompare(other.run.id))[0];
}

function sideBySide(results: string, layouts: string[], shown: Map<string, Scored | undefined>): string[] {
    const cell = (layout: string) => {
        const scored = shown.get(layout);
        if (! scored) {
            return [ '<td valign="top">', '', '(no run with a result)', '', '</td>' ];
        }
        const directory = join(results, 'runs', scored.run.id);
        const diff = readIf(join(directory, 'diff.patch'))?.trimEnd();
        const reply = readIf(join(directory, 'reply.md'))?.trim();
        return [
            '<td valign="top">',
            '',
            ...(diff ? [ '```diff', diff, '```' ] : [ '(no diff)' ]),
            '',
            "**The agent's reply**",
            '',
            reply || NO_REPLY,
            '',
            '</td>',
        ];
    };
    const heading = (layout: string) => {
        const scored = shown.get(layout);
        return `<th>${ layout }${ scored ? `: run ${ scored.run.id }, ${ scored.run.agent }, ${ scored.record.outcome }` : '' }</th>`;
    };
    return [
        '<table>',
        `<tr>${ layouts.map(heading).join('') }</tr>`,
        '<tr>',
        ...layouts.flatMap(cell),
        '</tr>',
        '</table>',
    ];
}

/**
 * compare.md for a mode's results: a section per request, with each layout's runs, correct runs, how often each
 * checklist item the request exercises passed, and each other item a run's code applied to, the skill files its runs loaded, and one run's diff per layout, side by
 * side, with the agent's reply.
 */
export function compareResults(results: string, { agent }: { agent?: Agent } = {}): string {
    // a plan has runs of every agent; with an agent, only its runs, since a round run with --agent leaves the others without results for good
    const planned = readPlan(results, agent ? [ agent ] : AGENTS);
    const scores = readScores(join(results, 'review', 'scores.json'));
    const scored: Scored[] = planned.flatMap(run => {
        const result = join(results, 'runs', run.id, 'result.json');
        return existsSync(result) ? [ { run, record: readRecord(result) } ] : [];
    });
    const requests = [ ...new Set(planned.map(run => run.request)) ]
        .sort((one, other) => Number(one.split('-')[0]) - Number(other.split('-')[0]));

    const sections = requests.flatMap(request => {
        const runsOf = (layout: string) => scored.filter(({ run }) => run.request === request && run.layout === layout);
        /** The layout's runs that reached a verdict: a run that couldn't reach the scenarios' APIs says nothing about the layout */
        const judgedOf = (layout: string) => runsOf(layout).filter(({ record }) => record.outcome !== 'network-failure' && record.outcome !== 'agent-failure');
        const countOf = (layout: string, outcome: RunRecord['outcome']) => runsOf(layout).filter(({ record }) => record.outcome === outcome).length;
        const layouts = LAYOUTS.filter(layout => planned.some(run => run.request === request && run.layout === layout));
        const items = CHECKLIST.filter(item => exercises(request, item.id));
        // the items the request doesn't exercise, where a run has a verdict on them, since every item that applies is scored
        const others = CHECKLIST.filter(item => ! exercises(request, item.id)
            && layouts.some(layout => judgedOf(layout).some(run => verdictOf(run, item.id, scores) !== 'n/a')));
        const files = [ ...new Set(scored.filter(({ run }) => run.request === request).flatMap(({ record }) => record.skillReads.map(read => read.file))) ].sort();

        const itemRow = (item: ChecklistItem): [ string, string[] ] => [ `\`${ item }\``, layouts.map(layout => {
            const verdicts = judgedOf(layout).map(run => verdictOf(run, item, scores)).filter(verdict => verdict !== 'n/a');
            return verdicts.length === 0 ? 'n/a' : share(verdicts.filter(verdict => verdict === 'pass').length, verdicts.length);
        }) ];
        const fileRow = (file: string): [ string, string[] ] => [ `\`${ file }\``, layouts.map(layout =>
            share(runsOf(layout).filter(({ record }) => record.skillReads.some(read => read.file === file)).length, runsOf(layout).length)) ];

        return [
            `## ${ request }`,
            '',
            ...table('', layouts, [
                [ 'Runs with a result', layouts.map(layout => String(runsOf(layout).length)) ],
                [ 'Network failures', layouts.map(layout => String(countOf(layout, 'network-failure'))) ],
                [ 'Agent failures', layouts.map(layout => String(countOf(layout, 'agent-failure'))) ],
                [ 'Models', layouts.map(layout => modelCell(runsOf(layout))) ],
                ...(scored.some(({ run, record }) => run.request === request && record.autoMode)
                    ? [ [ 'Models Auto could choose from', layouts.map(layout => modelCell(runsOf(layout), record => record.autoMode?.availableModels ?? [])) ] as [ string, string[] ] ]
                    : []),
                [ 'Correct', layouts.map(layout => share(judgedOf(layout).filter(({ record }) => record.outcome === 'correct').length, judgedOf(layout).length)) ],
                ...items.map(item => itemRow(item.id)),
            ]),
            '',
            ...(others.length > 0 ? [ ...table('Other item', layouts, others.map(item => itemRow(item.id))), '' ] : []),
            'Correct and the checklist items leave out the network failures, runs whose tests couldn\'t reach the scenarios\' APIs, and the agent failures, runs whose agent errored or made no tool calls. Models are the ones the runs\' streams name as answering, with how many runs used each; with a pin of "auto" the agent picks them, so the layouts only compare when their mixes match, and Models Auto could choose from says whether Copilot had more than one to pick from. A checklist item counts the runs where it applied: passed of applicable, with the reviewer\'s verdicts over the patterns\', and n/a where no run has a verdict on it yet, such as an item only the reviewer scores, before the review. The other items are those the request doesn\'t exercise, where the code a run added applied to them.',
            '',
            ...(files.length > 0
                ? table('Skill file', layouts, files.map(fileRow))
                : [ 'No run of this request loaded a skill file.' ]),
            '',
            ...sideBySide(results, layouts, new Map(layouts.map(layout => [ layout, shownRunOf(runsOf(layout)) ]))),
            '',
        ];
    });

    // the runs with a result of each layout with each agent, against the sample the decision rule needs
    const samples = [ ...new Set(scored.map(({ run }) => `${ run.layout } ${ run.agent }`)) ]
        .map(sample => scored.filter(({ run }) => `${ run.layout } ${ run.agent }` === sample).length);
    const smallest = tooSmallToDecide(samples);

    return [
        '# The layouts compared, request by request',
        '',
        agent
            ? `${ agent }'s runs only: ${ scored.length } of its ${ planned.length } planned runs have a result.`
            : `Every agent's runs: ${ scored.length } of the ${ planned.length } planned runs have a result.`,
        '',
        ...(smallest !== undefined
            ? [ `Too small to decide: ${ runsCount(smallest) } per layout per agent, and the decision rule needs ${ RUNS_PER_LAYOUT_FOR_A_DECISION }. The counts and percentages below show what happened, not which layout is better.`, '' ]
            : []),
        ...sections,
    ].join('\n');
}
