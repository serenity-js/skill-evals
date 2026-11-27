// Calibrating the judge against the reviewer: the judge scores every run the reviewer scored, in the recorded rounds,
// three times, from what the reviewer had, and the report says, item by item, how often its verdicts agree with the
// reviewer's in review/scores.json. review-guide.md cites runs of those very rounds, so agreement is reported on every
// verdict, and on the held-out ones, which the guide doesn't cite under the item. Until an item is calibrated, the
// judge's verdicts on it don't count anywhere. The protocol is in the README, under "Calibrating the judge".
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { adapterOf, type AgentHomes, prepareAgentHomes, versionOf } from './agents/index.ts';
import { urlsOf } from './api-server.ts';
import { run, runBuffer } from './child-processes.ts';
import { hashOf } from './conditions.ts';
import { CHECKLIST, type ChecklistItem, exercises, type Verdict } from './conventions.ts';
import { JUDGE_PROMPT, JUDGE_PROMPT_WITHOUT_PROJECT, judge, type JudgeInput, type JudgeRule, type JudgeSession, type JudgeVerdict, prepareJudgeDirectory, type Spawn } from './judge.ts';
import { evalRoot } from './layouts.ts';
import { referenceFilesOf, withoutMarkers } from './references.ts';
import { fillInUrls, loadRequests, promptFor, type Request } from './requests.ts';
import { Results, writeJson } from './results.ts';
import { asVerdict, type PlannedRun, REVIEW_GUIDE } from './review.ts';
import type { Config } from './runs.ts';
import { Work } from './work.ts';

/** How many sessions judge each run, so that the judge's noise shows, and the majority is compared with the reviewer. */
export const REPEATS = 3;
/** The share of held-out verdicts the judge has to agree with, of at least MIN_HELD_OUT */
export const AGREEMENT = 0.85;
export const MIN_HELD_OUT = 10;
/** With at least MIN_FAILS of the reviewer's fails, the judge has to fail at least CAUGHT of those runs too */
export const MIN_FAILS = 3;
export const CAUGHT = 2 / 3;

// ---------------------------------------------------------------------------------------------------------------------
// The review guide, as the judge's rules

/** A section of review-guide.md: its heading, the items its **Items** line names, its text, and the runs it cites. */
export interface GuideSection {
    heading: string;
    items: ChecklistItem[];
    text: string;
    /** The IDs of the runs it cites, as `*<id>*` */
    cited: string[];
}

const RUN_ID = /\*([\da-f]{8})\*/g;
const ITEM_IDS = new Set<string>(CHECKLIST.map(item => item.id));

/** The guide's `##` and `###` sections, each with its own text, and the items and runs it names. */
export function guideSections(markdown: string): GuideSection[] {
    return markdown.split(/\n(?=#{2,3} )/).filter(part => /^#{2,3} /.test(part)).map(part => {
        const [ title, ...lines ] = part.split('\n');
        const heading = title.replace(/^#+\s*/, '');
        const itemsLine = /\*\*Items:\*\*([^\n]*)/.exec(part)?.[1] ?? '';
        const named = [ ...itemsLine.matchAll(/`([^`]+)`/g) ].map(match => match[1]);
        const unknown = named.filter(item => ! ITEM_IDS.has(item));
        if (unknown.length > 0) {
            throw new Error(`review-guide.md's section "${ heading }" names ${ unknown.join(', ') }, which aren't items of the checklist`);
        }
        return {
            heading,
            items: named as ChecklistItem[],
            text: lines.join('\n').replace(/\*\*Items:\*\*[^\n]*\n?/, '').trim(),
            cited: [ ...new Set([ ...part.matchAll(RUN_ID) ].map(match => match[1])) ],
        };
    });
}

/** The (run, item) pairs the guide cites, as `<run> <item>`: a run cited in a section that names the item. */
export function citedPairs(sections: GuideSection[]): Set<string> {
    return new Set(sections.flatMap(section => section.cited.flatMap(id => section.items.map(item => `${ id } ${ item }`))));
}

/**
 * The checklist as the judge's rules: each item's text, then the guide's sections that name it, with each run the
 * guide cites renamed `run R<n>`, numbered in the order the guide first cites them, so the judge can't tell which run
 * it is from its ID. Links to other sections of the guide keep their text only.
 */
export function rulesOf(guide: string): JudgeRule[] {
    const sections = guideSections(guide);
    const numbers = new Map<string, number>();
    for (const id of sections.flatMap(section => section.cited)) {
        if (! numbers.has(id)) {
            numbers.set(id, numbers.size + 1);
        }
    }
    const anonymous = (text: string) => text
        .replace(RUN_ID, (_, id: string) => `*run R${ numbers.get(id) }*`)
        .replace(/\[([^\]]+)\]\(#[^)]*\)/g, '$1');
    return CHECKLIST.map(item => ({
        id: item.id,
        readme: [
            `# ${ item.id }`,
            '',
            item.text,
            ...sections.filter(section => section.items.includes(item.id)).flatMap(section => [ '', `## ${ section.heading }`, '', anonymous(section.text) ]),
        ].join('\n'),
    }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The recorded rounds

/** A run the reviewer scored, with the verdicts they gave, item by item; the items they left blank aren't there. */
export interface ReviewedRun {
    round: string;
    results: Results;
    run: PlannedRun;
    verdicts: Partial<Record<ChecklistItem, Verdict>>;
}

const MODES = /^(pilot|full|smoke|held-back-.+)$/;

/** A round's name: its directory's, or, for a mode's results such as `<round>/pilot`, the round's. */
export function roundNameOf(directory: string): string {
    return MODES.test(basename(directory)) ? basename(dirname(directory)) : basename(directory);
}

/** The runs of a round that the reviewer scored at least one item of, in the plan's order. */
export function reviewedRunsOf(directory: string, round: string = roundNameOf(directory)): ReviewedRun[] {
    const results = new Results(directory);
    const scores = results.scores();
    return results.plan().flatMap(planned => {
        const verdicts = Object.fromEntries(CHECKLIST.flatMap(({ id }) => {
            const verdict = asVerdict(scores[planned.id]?.[id], `${ id } of run ${ planned.id }, in ${ round }`);
            return verdict ? [ [ id, verdict ] ] : [];
        })) as Partial<Record<ChecklistItem, Verdict>>;
        if (Object.keys(verdicts).length === 0) {
            return [];
        }
        if (results.run(planned.id).read('diff') === undefined) {
            throw new Error(`run ${ planned.id }, in ${ round }, was reviewed, but has no diff.patch`);
        }
        return [ { round, results, run: planned, verdicts } ];
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// The project before and after a run

/** A version of a fixture: as it is, or as a commit of the harness's history has it. */
export interface FixtureVersion {
    label: string;
    copyTo(directory: string): void;
}

/**
 * The versions of a request's fixture, newest first: as it is in `fixtures/`, then as each commit that changed it left
 * it, from the harness's git history. None for a request without one, which only has the template.
 */
export function fixtureVersions(fixture: string | undefined, root: string = evalRoot): FixtureVersion[] {
    if (fixture === undefined) {
        return [ { label: 'no fixture', copyTo: () => {} } ];
    }
    const current = join(root, 'fixtures', fixture);
    // the fixture's path in the repository, as git has it, whatever links the path to the repository goes through
    const top = run('git', [ 'rev-parse', '--show-toplevel' ], { cwd: current, stdio: 'pipe' }).trim();
    const path = run('git', [ 'rev-parse', '--show-prefix' ], { cwd: current, stdio: 'pipe' }).trim().replace(/\/$/, '');
    const commits = run('git', [ 'log', '--format=%H', '--', path ], { cwd: top, stdio: 'pipe' }).split('\n').filter(Boolean);
    return [
        { label: `the ${ fixture } fixture as it is`, copyTo: directory => cpSync(current, directory, { recursive: true }) },
        ...commits.map(commit => ({
            label: `the ${ fixture } fixture as of ${ commit.slice(0, 7) }`,
            copyTo: (directory: string) => {
                const scratch = mkdtempSync(join(tmpdir(), 'skill-layouts-fixture-'));
                try {
                    runBuffer('tar', [ '-x', '-C', scratch ], { input: runBuffer('git', [ 'archive', commit, path ], { cwd: top, maxBuffer: 256 * 1024 * 1024 }) });
                    if (existsSync(join(scratch, path))) {
                        cpSync(join(scratch, path), directory, { recursive: true });
                    }
                }
                finally {
                    rmSync(scratch, { recursive: true, force: true });
                }
            },
        })),
    ];
}

const git = (cwd: string, args: string[]) =>
    run('git', [ '-c', 'user.name=skill-layouts', '-c', 'user.email=skill-layouts@localhost', '-c', 'commit.gpgsign=false', ...args ], { cwd, stdio: 'pipe' });

/**
 * The project as the run found it, in `<directory>/before`, and as it left it, in `<directory>/after`: the template at
 * the round's commit, with the newest version of the request's fixture that the run's diff applies to, since a
 * fixture may have changed since the round. Returns which version that was.
 */
export function buildStartingProject(directory: string, { template, commit, versions, diff }: { template: string, commit: string, versions: FixtureVersion[], diff: string }): string {
    const before = join(directory, 'before');
    const after = join(directory, 'after');
    const patch = join(directory, 'run.patch');
    mkdirSync(directory, { recursive: true });
    writeFileSync(patch, diff);
    const archive = runBuffer('git', [ 'archive', commit ], { cwd: template, maxBuffer: 256 * 1024 * 1024 });
    const reasons: string[] = [];
    for (const version of versions) {
        rmSync(before, { recursive: true, force: true });
        rmSync(after, { recursive: true, force: true });
        mkdirSync(before, { recursive: true });
        runBuffer('tar', [ '-x', '-C', before ], { input: archive });
        version.copyTo(before);
        cpSync(before, after, { recursive: true });
        if (diff.trim() === '') {
            return version.label;
        }
        git(after, [ 'init', '--quiet' ]);
        try {
            git(after, [ 'apply', '--whitespace=nowarn', patch ]);
            return version.label;
        }
        catch (error) {
            reasons.push(`${ version.label }: ${ String((error as { stderr?: string }).stderr ?? '').trim().split('\n')[0] }`);
        }
        finally {
            rmSync(join(after, '.git'), { recursive: true, force: true });
        }
    }
    throw new Error(`its diff doesn't apply to the template at ${ commit } with ${ reasons.join('; ') }`);
}

/** What the judge is given about a reviewed run: what the reviewer's packet had, the project before and after, the rules and the reference. */
export function judgeInputOf(reviewed: ReviewedRun, { rules, request, port, before, after }: { rules: JudgeRule[], request: Request, port: number, before?: string, after?: string }): JudgeInput {
    const files = reviewed.results.run(reviewed.run.id);
    const urls = urlsOf(port);
    const exercised = rules.filter(rule => exercises(request.id, rule.id as ChecklistItem));
    return {
        request: promptFor(request, urls),
        diff: files.read('diff') ?? '',
        reply: files.read('reply') ?? '',
        before,
        after,
        rules: [ ...exercised, ...rules.filter(rule => ! exercised.includes(rule)) ],
        exercised: exercised.map(rule => rule.id),
        reference: new Map([ ...withoutMarkers(referenceFilesOf(request.id)) ].map(([ file, content ]) => [ file, fillInUrls(content, urls) ])),
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// The report

/** One of the reviewer's verdicts, with the judge's verdicts on the same run and item, one per session. */
export interface CalibrationEntry {
    round: string;
    run: string;
    item: ChecklistItem;
    reviewer: Verdict;
    /** Whether the guide doesn't cite the run under a section that names the item */
    heldOut: boolean;
    /** Whether the judge had only the diff, since the run's project couldn't be rebuilt */
    withoutProject?: boolean;
    /** Each session's verdict, or undefined for a session that left none */
    judged: Array<JudgeVerdict | undefined>;
}

/** The verdict most of the sessions that gave one agree on, `split` when no verdict has a majority, `missing` when none gave one. */
export type Majority = Verdict | 'split' | 'missing';

export function majorityOf(verdicts: Array<Verdict | undefined>): Majority {
    const given = verdicts.filter((verdict): verdict is Verdict => verdict !== undefined);
    if (given.length === 0) {
        return 'missing';
    }
    const counts = new Map<Verdict, number>();
    for (const verdict of given) {
        counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
    }
    const [ top, count ] = [ ...counts ].sort((one, other) => other[1] - one[1])[0];
    return count * 2 > given.length ? top : 'split';
}

export interface Share {
    count: number;
    of: number;
}

export type CalibrationStatus = 'calibrated' | 'calibrated against false alarms only' | 'not calibrated' | 'too few held-out verdicts';

export interface ItemCalibration {
    item: ChecklistItem;
    reviewer: Record<Verdict, number>;
    /** The judge's majority agrees with the reviewer, of the verdicts it gave a majority or a split on */
    agreement: Share;
    heldOut: Share;
    /** Of the reviewer's fails, how many the judge's majority failed too */
    failsCaught: Share;
    confusion: { reviewerPassJudgeFail: number, reviewerFailJudgePass: number, otherNa: number, split: number, missing: number };
    /** Of the runs with two sessions' verdicts or more, how many had every session agree */
    unanimous: Share;
    status: CalibrationStatus;
    why: string;
}

export interface Disagreement {
    round: string;
    run: string;
    item: ChecklistItem;
    reviewer: Verdict;
    judge: Majority;
    heldOut: boolean;
    /** Each session's verdict and reason */
    reasons: string[];
}

export interface SessionsSummary {
    sessions: number;
    /** Sessions that left no usable verdicts, after their second attempt */
    withoutVerdicts: number;
    /** Sessions that needed a second attempt */
    retried: number;
    credits: number;
    durationMs: number;
}

export interface CalibrationReport {
    judge: { agent: string, model: string, version: string };
    items: ItemCalibration[];
    rounds: Array<{ round: string, agreement: Share, heldOut: Share }>;
    disagreements: Disagreement[];
    sessions: SessionsSummary;
    /** The runs whose project couldn't be rebuilt, which the judge scored from their diff alone, and why */
    withoutProject: Array<{ round: string, run: string, reason: string }>;
}

const percent = (share: Share) => share.of === 0 ? 'n/a' : `${ Math.round(100 * share.count / share.of) }%`;
const shareOf = (share: Share) => `${ share.count } of ${ share.of } (${ percent(share) })`;

function agreementOf(entries: CalibrationEntry[]): Share {
    const judged = entries.filter(entry => majorityOf(entry.judged.map(verdict => verdict?.verdict)) !== 'missing');
    return { count: judged.filter(entry => majorityOf(entry.judged.map(verdict => verdict?.verdict)) === entry.reviewer).length, of: judged.length };
}

/** The protocol's decision about an item, from its counts, as the README's "Calibrating the judge" says. */
export function statusOf({ heldOut, failsCaught }: Pick<ItemCalibration, 'heldOut' | 'failsCaught'>): { status: CalibrationStatus, why: string } {
    if (heldOut.of < MIN_HELD_OUT) {
        return { status: 'too few held-out verdicts', why: `${ heldOut.of } held-out verdict${ heldOut.of === 1 ? '' : 's' }, of the ${ MIN_HELD_OUT } it needs` };
    }
    if (heldOut.count < AGREEMENT * heldOut.of) {
        return { status: 'not calibrated', why: `agrees with ${ shareOf(heldOut) } held-out verdicts, under ${ AGREEMENT * 100 }%` };
    }
    if (failsCaught.of < MIN_FAILS) {
        return {
            status: 'calibrated against false alarms only',
            why: `the reviewer failed it ${ failsCaught.of } time${ failsCaught.of === 1 ? '' : 's' }, fewer than ${ MIN_FAILS }, so the agreement can't show that the judge tells a failure`,
        };
    }
    if (failsCaught.count < CAUGHT * failsCaught.of) {
        return { status: 'not calibrated', why: `fails ${ shareOf(failsCaught) } of the runs the reviewer failed, under two thirds` };
    }
    return { status: 'calibrated', why: `agrees with ${ shareOf(heldOut) } held-out verdicts, and fails ${ shareOf(failsCaught) } of the reviewer's fails` };
}

/** How the judge's verdicts compare with the reviewer's, item by item and round by round, with every disagreement. */
export function calibrationReport(
    entries: CalibrationEntry[],
    { judge: judgeOf, sessions, withoutProject }: Pick<CalibrationReport, 'judge' | 'sessions' | 'withoutProject'>,
): CalibrationReport {
    const majority = (entry: CalibrationEntry) => majorityOf(entry.judged.map(verdict => verdict?.verdict));
    const items = CHECKLIST.map(({ id }) => id).filter(item => entries.some(entry => entry.item === item)).map(item => {
        const ofItem = entries.filter(entry => entry.item === item);
        const fails = ofItem.filter(entry => entry.reviewer === 'fail');
        const withSessions = ofItem.filter(entry => entry.judged.filter(Boolean).length >= 2);
        const counts = {
            agreement: agreementOf(ofItem),
            heldOut: agreementOf(ofItem.filter(entry => entry.heldOut)),
            failsCaught: { count: fails.filter(entry => majority(entry) === 'fail').length, of: fails.length },
        };
        return {
            item,
            reviewer: { 'pass': 0, 'fail': 0, 'n/a': 0, ...Object.fromEntries([ 'pass', 'fail', 'n/a' ].map(verdict => [ verdict, ofItem.filter(entry => entry.reviewer === verdict).length ])) } as Record<Verdict, number>,
            ...counts,
            confusion: {
                reviewerPassJudgeFail: ofItem.filter(entry => entry.reviewer === 'pass' && majority(entry) === 'fail').length,
                reviewerFailJudgePass: ofItem.filter(entry => entry.reviewer === 'fail' && majority(entry) === 'pass').length,
                otherNa: ofItem.filter(entry => [ 'pass', 'fail', 'n/a' ].includes(majority(entry)) && majority(entry) !== entry.reviewer && (entry.reviewer === 'n/a' || majority(entry) === 'n/a')).length,
                split: ofItem.filter(entry => majority(entry) === 'split').length,
                missing: ofItem.filter(entry => majority(entry) === 'missing').length,
            },
            unanimous: {
                count: withSessions.filter(entry => new Set(entry.judged.filter(Boolean).map(verdict => verdict!.verdict)).size === 1).length,
                of: withSessions.length,
            },
            ...statusOf(counts),
        };
    });
    const rounds = [ ...new Set(entries.map(entry => entry.round)) ].map(round => {
        const ofRound = entries.filter(entry => entry.round === round);
        return { round, agreement: agreementOf(ofRound), heldOut: agreementOf(ofRound.filter(entry => entry.heldOut)) };
    });
    const disagreements = entries
        .filter(entry => ! [ entry.reviewer, 'missing' ].includes(majority(entry)))
        .map(entry => ({
            round: entry.round,
            run: entry.run,
            item: entry.item,
            reviewer: entry.reviewer,
            judge: majority(entry),
            heldOut: entry.heldOut,
            reasons: entry.judged.flatMap(verdict => verdict ? [ `${ verdict.verdict }: ${ verdict.reason }` ] : []),
        }));
    return { judge: judgeOf, items, rounds, disagreements, sessions, withoutProject };
}

/** calibration.md: the item-by-item table first, then the rounds, the confusion, every disagreement, and the cost. */
export function renderCalibration(report: CalibrationReport): string {
    const verdictCounts = (counts: Record<Verdict, number>) => `${ counts.pass } / ${ counts.fail } / ${ counts['n/a'] }`;
    return [
        '# Calibrating the judge',
        '',
        `The judge is ${ report.judge.agent } ${ report.judge.version }, with ${ report.judge.model }, compared with the reviewer's verdicts in each round's review/scores.json.`,
        `Each run is judged by ${ REPEATS } sessions, and their majority is compared. A verdict is held out when review-guide.md doesn't cite its run under a section that names its item.`,
        `An item is calibrated when the judge agrees with at least ${ AGREEMENT * 100 }% of at least ${ MIN_HELD_OUT } held-out verdicts, and, where the reviewer failed it at least ${ MIN_FAILS } times, fails at least two thirds of those runs too.`,
        '',
        '## Items',
        '',
        '| Item | Reviewer: pass / fail / n/a | Agreement | Held out | Reviewer\'s fails caught | Sessions unanimous | Status |',
        '|---|---|---|---|---|---|---|',
        ...report.items.map(item => `| ${ item.item } | ${ verdictCounts(item.reviewer) } | ${ shareOf(item.agreement) } | ${ shareOf(item.heldOut) } | ${ shareOf(item.failsCaught) } | ${ shareOf(item.unanimous) } | ${ item.status }: ${ item.why } |`),
        '',
        '## Rounds',
        '',
        '| Round | Agreement | Held out |',
        '|---|---|---|',
        ...report.rounds.map(round => `| ${ round.round } | ${ shareOf(round.agreement) } | ${ shareOf(round.heldOut) } |`),
        '',
        '## Where the judge differs',
        '',
        '| Item | Reviewer pass, judge fail | Reviewer fail, judge pass | Either n/a | Split | Missing |',
        '|---|---|---|---|---|---|',
        ...report.items.map(({ item, confusion }) => `| ${ item } | ${ confusion.reviewerPassJudgeFail } | ${ confusion.reviewerFailJudgePass } | ${ confusion.otherNa } | ${ confusion.split } | ${ confusion.missing } |`),
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

// ---------------------------------------------------------------------------------------------------------------------
// Calibrating

/** Where the calibration keeps its sessions and its report, in `<out>/calibration`. */
export class CalibrationFiles {

    readonly directory: string;
    readonly markdown: string;
    readonly json: string;

    constructor(out: string) {
        this.directory = join(out, 'calibration');
        this.markdown = join(this.directory, 'calibration.md');
        this.json = join(this.directory, 'calibration.json');
    }

    /** A session's streams, logs, session.json and verdicts.json */
    session(round: string, run: string, repeat: number): string {
        return join(this.directory, 'sessions', round, run, String(repeat));
    }
}

/** What a session leaves in its directory, besides its streams and logs. */
interface SavedSession extends JudgeSession {
    /** The hash of the prompt and of everything the judge was given, so a session of another prompt or other inputs isn't reused */
    inputHash: string;
}

export interface CalibrateOptions {
    /** The rounds' results, each a mode's directory such as `<round>/pilot` */
    rounds: string[];
    /** A clone of the template, with the rounds' commits */
    template: string;
    out: string;
    work: string;
    config: Pick<Config, 'judge' | 'runTimeoutMinutes' | 'apiServer'>;
    repeats?: number;
    guide?: string;
    env?: NodeJS.ProcessEnv;
    spawn?: Spawn;
    versionsOf?: (fixture: string | undefined) => FixtureVersion[];
    judgeVersion?: string;
    log?: (message: string) => void;
}

/** A fresh home for the judge's agent, for each session, in the homes every session shares, so no session sees another's. */
function freshAgentHome(homes: AgentHomes, agent: Config['judge']['agent']): void {
    const adapter = adapterOf(agent);
    const home = homes[adapter.homeVariable];
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    adapter.prepareHome(home);
}

function savedSession(directory: string): SavedSession | undefined {
    const file = join(directory, 'session.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as SavedSession : undefined;
}

/**
 * Judges every run the reviewer scored, in every round, `repeats` times, resuming from the sessions of the same prompt
 * and inputs that are already done, and writes the report.
 */
export async function calibrate(options: CalibrateOptions): Promise<CalibrationReport> {
    const { rounds, template, out, work, config, repeats = REPEATS, env = process.env, spawn, versionsOf = fixture => fixtureVersions(fixture), log = () => {} } = options;
    const names = rounds.map(directory => roundNameOf(directory));
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    if (repeated !== undefined) {
        throw new Error(`two rounds are named ${ repeated }: give each round's results a directory of its own name`);
    }
    const guide = options.guide ?? readFileSync(REVIEW_GUIDE, 'utf8');
    const rules = rulesOf(guide);
    const cited = citedPairs(guideSections(guide));
    const { requests, heldBack } = loadRequests();
    const requestOf = new Map([ ...requests, ...heldBack ].map(request => [ request.id, request ]));
    const files = new CalibrationFiles(out);
    const scratch = join(work, 'calibration');
    const homes = prepareAgentHomes(join(work, 'homes', 'judge'), new Work(work).npmCache);

    const entries: CalibrationEntry[] = [];
    const withoutProject: CalibrationReport['withoutProject'] = [];
    const sessions: SessionsSummary = { sessions: 0, withoutVerdicts: 0, retried: 0, credits: 0, durationMs: 0 };

    for (const [ index, directory ] of rounds.entries()) {
        const round = names[index];
        const reviewed = reviewedRunsOf(directory, round);
        const conditions = new Results(directory).conditions();
        if (! conditions?.shared?.template?.commit) {
            throw new Error(`${ round }'s conditions.json doesn't record the template's commit, which the runs started from`);
        }
        const port = conditions.shared.apiServer?.port ?? config.apiServer.port;
        log(`${ round }: ${ reviewed.length } reviewed runs`);
        for (const run of reviewed) {
            const request = requestOf.get(run.run.request);
            if (! request) {
                throw new Error(`run ${ run.run.id }, in ${ round }, is of ${ run.run.request }, which requests.json doesn't have`);
            }
            const project = join(scratch, round, run.run.id);
            let hasProject = true;
            try {
                buildStartingProject(project, { template, commit: conditions.shared.template.commit, versions: versionsOf(request.fixture), diff: run.results.run(run.run.id).read('diff') ?? '' });
            }
            catch (error) {
                hasProject = false;
                withoutProject.push({ round, run: run.run.id, reason: (error as Error).message });
                log(`${ round } ${ run.run.id }: judged from its diff alone: ${ (error as Error).message }`);
            }
            const input = judgeInputOf(run, { rules, request, port, ...(hasProject ? { before: join(project, 'before'), after: join(project, 'after') } : {}) });
            const prompt = hasProject ? JUDGE_PROMPT : JUDGE_PROMPT_WITHOUT_PROJECT;
            const judged: Array<JudgeSession | undefined> = [];
            for (let repeat = 1; repeat <= repeats; repeat++) {
                const judgeDirectory = join(work, 'judge', randomBytes(4).toString('hex'));
                prepareJudgeDirectory(judgeDirectory, input);
                const inputHash = createHash('sha256').update(prompt).update('\0').update(hashOf(judgeDirectory)).digest('hex');
                const output = files.session(round, run.run.id, repeat);
                const saved = savedSession(output);
                let session: JudgeSession;
                if (saved?.inputHash === inputHash) {
                    session = saved;
                    log(`${ round } ${ run.run.id } #${ repeat }: done before`);
                }
                else {
                    rmSync(output, { recursive: true, force: true });
                    freshAgentHome(homes, config.judge.agent);
                    session = await judge(judgeDirectory, rules.map(rule => rule.id), { config, homes, output, env, spawn, prompt });
                    writeJson(join(output, 'session.json'), { inputHash, ...session });
                    if (session.verdicts) {
                        writeJson(join(output, 'verdicts.json'), { verdicts: session.verdicts });
                    }
                    log(`${ round } ${ run.run.id } #${ repeat }: ${ session.verdicts ? 'judged' : `no verdicts: ${ session.problems.join('; ') }` }`);
                }
                rmSync(judgeDirectory, { recursive: true, force: true });
                judged.push(session);
                sessions.sessions++;
                sessions.retried += session.attempts > 1 ? 1 : 0;
                sessions.withoutVerdicts += session.verdicts ? 0 : 1;
                sessions.credits += session.credits ?? 0;
                sessions.durationMs += session.durationMs;
            }
            rmSync(project, { recursive: true, force: true });
            for (const [ item, reviewer ] of Object.entries(run.verdicts) as Array<[ ChecklistItem, Verdict ]>) {
                entries.push({
                    round,
                    run: run.run.id,
                    item,
                    reviewer,
                    heldOut: ! cited.has(`${ run.run.id } ${ item }`),
                    ...(hasProject ? {} : { withoutProject: true }),
                    judged: judged.map(session => session?.verdicts?.find(verdict => verdict.rule === item)),
                });
            }
        }
    }

    const report = calibrationReport(entries, {
        judge: { agent: config.judge.agent, model: config.judge.model, version: options.judgeVersion ?? versionOf(adapterOf(config.judge.agent)) },
        sessions,
        withoutProject,
    });
    mkdirSync(files.directory, { recursive: true });
    writeJson(files.json, { ...report, entries });
    writeFileSync(files.markdown, renderCalibration(report));
    return report;
}
