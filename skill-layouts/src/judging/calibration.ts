// Calibrating the judge against the reviewer: the judge scores every run the reviewer scored, in the recorded rounds,
// as many times as the protocol says, from what the reviewer had, and the report says, item by item, how often its
// verdicts agree with the reviewer's in review/scores.json. review-guide.md cites runs of those very rounds, so
// agreement is reported on every verdict, and on the held-out ones, which the guide doesn't cite under the item. Until
// an item is calibrated, the judge's verdicts on it don't count anywhere. The protocol is in the README, under
// "Calibrating the judge".
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Request } from '../requests.ts';
import type { Blinding } from '../review.ts';
import { writeJson } from '../results.ts';
import { Ballot } from './ballot.ts';
import { Comparison } from './comparison.ts';
import type { JudgeBrief } from './brief.ts';
import { type Judge, JudgePrompt, type JudgeSession } from './judge.ts';
import { renderCalibration } from './markdown.ts';
import type { CalibrationProtocol } from './protocol.ts';
import { RecordedRound, type RecordedRounds, type ReviewedRun } from './recorded-round.ts';
import { CalibrationReport, type RunWithoutProject, sessionsSummaryOf } from './report.ts';
import type { ReviewGuide } from './review-guide.ts';
import { type JudgeIdentity, type SessionKey, SessionStore } from './session-store.ts';
import type { FixtureHistory, ProjectBuilder, StartingProject } from './starting-project.ts';
import type { JudgeWorkspace } from './workspace.ts';

/** Where a calibration keeps its sessions and its report, in `<out>/calibration`. */
export class CalibrationFiles {

    readonly directory: string;
    readonly markdown: string;
    readonly json: string;
    readonly sessions: SessionStore;

    constructor(out: string) {
        this.directory = join(out, 'calibration');
        this.markdown = join(this.directory, 'calibration.md');
        this.json = join(this.directory, 'calibration.json');
        this.sessions = new SessionStore(this.directory);
    }

    /** calibration.json has the report and every comparison it's made from; calibration.md renders the report */
    saveReport(report: CalibrationReport, comparisons: readonly Comparison[], protocol: CalibrationProtocol): void {
        mkdirSync(this.directory, { recursive: true });
        writeJson(this.json, { ...report, entries: comparisons });
        writeFileSync(this.markdown, renderCalibration(report, protocol));
    }
}

/** What a Calibration works with. */
export interface CalibrationDependencies {
    judge: Judge;
    identity: JudgeIdentity;
    files: CalibrationFiles;
    guide: ReviewGuide;
    protocol: CalibrationProtocol;
    /** The checklist's item IDs, in its order, and whether a request exercises an item */
    checklist: { items: readonly string[], exercises: (request: string, item: string) => boolean };
    requests: ReadonlyMap<string, Request>;
    /** Reads the recorded rounds, for the checklist's items */
    rounds: RecordedRounds;
    /** A request's reference solution's files, by their paths in the project, without the marker of their expected value */
    references: { filesOf(request: string): ReadonlyMap<string, string> };
    projects: ProjectBuilder;
    fixtures: FixtureHistory;
    /** A clone of the template, with the rounds' commits */
    template: string;
    /** Where the runs' projects are rebuilt */
    work: string;
    /** Where the judge's directories are written */
    workspace: JudgeWorkspace;
    /** What hides the run's skills in the judge's brief */
    blinding: Blinding;
    log: (message: string) => void;
}

/** One calibration of the judge, over the recorded rounds. */
export class Calibration {

    private readonly dependencies: CalibrationDependencies;

    constructor(dependencies: CalibrationDependencies) {
        this.dependencies = dependencies;
    }

    /** Judges every reviewed run of the rounds, resuming from the sessions done before, and saves the report. */
    async run(roundDirectories: readonly string[]): Promise<CalibrationReport> {
        const { protocol, checklist, files, identity, log } = this.dependencies;
        const names = roundDirectories.map(directory => RecordedRound.nameOf(directory));
        const repeated = names.find((name, index) => names.indexOf(name) !== index);
        if (repeated !== undefined) {
            throw new Error(`two rounds are named ${ repeated }: give each round's results a directory of its own name`);
        }
        const comparisons: Comparison[] = [];
        const sessions: JudgeSession[] = [];
        const withoutProject: RunWithoutProject[] = [];
        for (const directory of roundDirectories) {
            const round = this.dependencies.rounds.read(directory);
            log(`${ round.name }: ${ round.reviewedRuns.length } reviewed runs`);
            for (const run of round.reviewedRuns) {
                const judged = await this.judgeRun(round, run, withoutProject);
                sessions.push(...judged.sessions);
                comparisons.push(...judged.comparisons);
            }
        }
        const report = CalibrationReport.of(comparisons, { items: checklist.items, protocol, judge: identity, sessions: sessionsSummaryOf(sessions), withoutProject });
        files.saveReport(report, comparisons, protocol);
        return report;
    }

    /** A reviewed run's sessions, and the reviewer's verdicts against them */
    private async judgeRun(round: RecordedRound, run: ReviewedRun, withoutProject: RunWithoutProject[]): Promise<{ sessions: JudgeSession[], comparisons: Comparison[] }> {
        const { requests, references, guide, protocol, checklist, judge, work, blinding } = this.dependencies;
        const request = requests.get(run.run.request);
        if (! request) {
            throw new Error(`run ${ run.id }, in ${ round.name }, is of ${ run.run.request }, which requests.json doesn't have`);
        }
        const scratch = join(work, 'calibration', round.name, run.id);
        const project = this.startingProject(round, run, request, scratch, withoutProject);
        const brief = run.brief({ rules: guide.rules, request, port: round.port, project, exercises: checklist.exercises, reference: references.filesOf(request.id), blinding });
        const judgeOfRun = project ? judge : judge.withPrompt(JudgePrompt.forDiffAlone());
        const sessions: JudgeSession[] = [];
        for (let repeat = 1; repeat <= protocol.sessionsPerRun; repeat++) {
            sessions.push(await this.session({ round: round.name, run: run.id, repeat }, judgeOfRun, brief));
        }
        rmSync(scratch, { recursive: true, force: true });
        return {
            sessions,
            comparisons: [ ...run.verdicts ].map(([ item, reviewer ]) => Comparison.of({
                round: round.name,
                run: run.id,
                item,
                reviewer,
                heldOut: ! guide.cites(run.id, item),
                withoutProject: project === undefined,
                ballot: Ballot.of(sessions.map(session => session.verdictOn(item))),
            })),
        };
    }

    /** The run's project, rebuilt, or undefined when its diff applies to no version of it, which the report lists */
    private startingProject(round: RecordedRound, run: ReviewedRun, request: Request, scratch: string, withoutProject: RunWithoutProject[]): StartingProject | undefined {
        const { projects, fixtures, template, log } = this.dependencies;
        try {
            return projects.build(scratch, { template, commit: round.templateCommit, versions: fixtures.versionsOf(request.fixture), diff: run.diff });
        }
        catch (error) {
            withoutProject.push({ round: round.name, run: run.id, reason: (error as Error).message });
            log(`${ round.name } ${ run.id }: judged from its diff alone: ${ (error as Error).message }`);
            return undefined;
        }
    }

    /** A session of the judge on the brief: the saved one, when its fingerprint still matches, or a new one */
    private async session(key: SessionKey, judge: Judge, brief: JudgeBrief): Promise<JudgeSession> {
        const { files, identity, guide, workspace, log } = this.dependencies;
        const fingerprint = brief.fingerprint(identity, judge.prompt);
        const label = `${ key.round } ${ key.run } #${ key.repeat }`;
        const saved = files.sessions.find(key, fingerprint);
        if (saved) {
            log(`${ label }: done before`);
            return saved;
        }
        files.sessions.clear(key);
        const directory = workspace.prepare(brief);
        const session = await judge.judge(directory, guide.rules.map(rule => rule.id), files.sessions.output(key));
        directory.remove();
        files.sessions.save(key, fingerprint, identity, session);
        log(`${ label }: ${ session.verdicts ? 'judged' : `no verdicts: ${ session.problems.join('; ') }` }`);
        return session;
    }
}
