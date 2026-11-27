import type { CalibrationProtocol } from './protocol.ts';
import type { CalibrationReport } from './report.ts';
import type { VerdictName } from './verdict.ts';

/** calibration.md: the item-by-item table first, then the rounds, the confusion, every disagreement, and the cost. */
export function renderCalibration(report: CalibrationReport, protocol: CalibrationProtocol): string {
    const verdictCounts = (counts: Record<VerdictName, number>) => `${ counts.pass } / ${ counts.fail } / ${ counts['n/a'] }`;
    return [
        '# Calibrating the judge',
        '',
        `The judge is ${ report.judge.agent } ${ report.judge.version }, with ${ report.judge.model }, compared with the reviewer's verdicts in each round's review/scores.json.`,
        `Each run is judged by ${ protocol.sessionsPerRun } sessions, and their majority is compared. A verdict is held out when review-guide.md doesn't cite its run under a section that names its item.`,
        `An item is calibrated when the judge agrees with at least ${ protocol.agreement * 100 }% of at least ${ protocol.minHeldOut } held-out verdicts, among which the reviewer failed it at least ${ protocol.minFails } times and passed it at least ${ protocol.minPasses } times, and the judge fails at least ${ protocol.caught.words } of the runs the reviewer failed.`,
        `With fewer than ${ protocol.minFails } held-out fails, an item is calibrated against false alarms only; with fewer than ${ protocol.minPasses } held-out passes, against misses only.`,
        '',
        '## Items',
        '',
        '| Item | Reviewer: pass / fail / n/a | Agreement | Held out | Reviewer\'s fails caught | Held-out fails caught | Held-out passes kept | Sessions unanimous | Status |',
        '|---|---|---|---|---|---|---|---|---|',
        ...report.items.map(item => `| ${ item.item } | ${ verdictCounts(item.reviewer) } | ${ item.agreement } | ${ item.heldOut } | ${ item.failsCaught } | ${ item.heldOutFailsCaught } | ${ item.heldOutPassesKept } | ${ item.unanimous } | ${ item.status }: ${ item.why } |`),
        '',
        '## Rounds',
        '',
        '| Round | Agreement | Held out |',
        '|---|---|---|',
        ...report.rounds.map(round => `| ${ round.round } | ${ round.agreement } | ${ round.heldOut } |`),
        '',
        '## Where the judge differs',
        '',
        'A split is three verdicts without a majority; an incomplete result is fewer than half of the sessions agreeing, since the others left no verdict. Both count against the agreement.',
        '',
        '| Item | Reviewer pass, judge fail | Reviewer fail, judge pass | Either n/a | Split | Incomplete | Missing |',
        '|---|---|---|---|---|---|---|',
        ...report.items.map(({ item, confusion }) => `| ${ item } | ${ confusion.reviewerPassJudgeFail } | ${ confusion.reviewerFailJudgePass } | ${ confusion.otherNa } | ${ confusion.split } | ${ confusion.incomplete } | ${ confusion.missing } |`),
        '',
        '## Every disagreement',
        '',
        ...(report.disagreements.length === 0 ? [ 'None.', '' ] : report.items.flatMap(({ item }) => {
            const ofItem = report.disagreements.filter(disagreement => disagreement.item === item);
            return ofItem.length === 0 ? [] : [
                `### ${ item }`,
                '',
                ...ofItem.flatMap(disagreement => [
                    `- **${ disagreement.round } ${ disagreement.run }**${ disagreement.heldOut ? '' : ' (cited by the guide)' }: the reviewer says ${ disagreement.reviewer }, the judge ${ disagreement.judge }`,
                    ...disagreement.reasons.map(reason => `  - ${ reason.replaceAll('\n', ' ') }`),
                ]),
                '',
            ];
        })),
        '## Sessions',
        '',
        `${ report.sessions.sessions } sessions, ${ report.sessions.retried } of them retried, ${ report.sessions.withoutVerdicts } left no verdicts the harness could use. They used ${ Math.round(report.sessions.credits * 100) / 100 } credits, and took ${ Math.round(report.sessions.durationMs / 60_000) } minutes.`,
        '',
        ...(report.withoutProject.length === 0 ? [] : [
            '## Runs judged from their diff alone',
            '',
            "Their project couldn't be rebuilt, so the judge had what the reviewer's packet had: the request, the diff and the reply.",
            '',
            ...report.withoutProject.map(({ round, run: id, reason }) => `- ${ round } ${ id }: ${ reason }`),
            '',
        ]),
    ].join('\n');
}
