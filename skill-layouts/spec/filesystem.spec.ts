import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CalibrationFiles } from '../src/judging/calibration.ts';
import { nodeFilesystem, writeJsonTo } from '../src/judging/filesystem.ts';
import { JudgeAttempt, JudgeSession } from '../src/judging/judge.ts';
import { CalibrationProtocol } from '../src/judging/protocol.ts';
import { CalibrationReport } from '../src/judging/report.ts';
import { JudgeVerdicts } from '../src/judging/rule-verdict.ts';
import { Fingerprint, JudgeIdentity } from '../src/judging/session-store.ts';
import { MemoryFilesystem } from './memory-filesystem.ts';

describe('the filesystem', () => {

    describe('as Node.js has it', () => {

        let root: string;
        const filesystem = nodeFilesystem();

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'skill-layouts-filesystem-'));
        });
        afterEach(() => rmSync(root, { recursive: true, force: true }));

        it('writes a file with the directories it is in, reads it, and reads none that is not there', () => {
            filesystem.writeFile(join(root, 'a', 'b', 'file.txt'), 'content');

            expect(filesystem.readFile(join(root, 'a', 'b', 'file.txt'))).toBe('content');
            expect(filesystem.readFile(join(root, 'a', 'missing.txt'))).toBeUndefined();
        });

        it('copies a directory with what the filter takes, and removes it, whether or not it is there', () => {
            mkdirSync(join(root, 'from', '.git'), { recursive: true });
            writeFileSync(join(root, 'from', 'kept.txt'), 'kept');
            writeFileSync(join(root, 'from', '.git', 'HEAD'), 'ref');

            filesystem.copy(join(root, 'from'), join(root, 'to'), path => ! path.includes('.git'));

            expect(filesystem.exists(join(root, 'to', 'kept.txt'))).toBe(true);
            expect(filesystem.exists(join(root, 'to', '.git'))).toBe(false);
            filesystem.remove(join(root, 'to'));
            filesystem.remove(join(root, 'to'));
            expect(filesystem.exists(join(root, 'to'))).toBe(false);
        });

        it('makes a new temporary directory each time, and a directory that is there already stays as it is', () => {
            const one = filesystem.makeTemporaryDirectory('skill-layouts-filesystem-');
            const other = filesystem.makeTemporaryDirectory('skill-layouts-filesystem-');
            filesystem.writeFile(join(one, 'file.txt'), 'content');
            filesystem.makeDirectory(one);

            expect(one).not.toBe(other);
            expect(readFileSync(join(one, 'file.txt'), 'utf8')).toBe('content');
            rmSync(one, { recursive: true });
            rmSync(other, { recursive: true });
        });

        it('writes JSON as the harness writes every JSON file', () => {
            writeJsonTo(filesystem, join(root, 'value.json'), { a: [ 1 ] });

            expect(readFileSync(join(root, 'value.json'), 'utf8')).toBe('{\n  "a": [\n    1\n  ]\n}\n');
        });
    });

    describe.each([
        [ 'as Node.js has it', () => ({ filesystem: nodeFilesystem(), root: mkdtempSync(join(tmpdir(), 'skill-layouts-filesystem-')) }) ],
        [ 'in memory', () => ({ filesystem: new MemoryFilesystem(), root: '/root' }) ],
    ])('%s, as the other has it', (_, made) => {

        let filesystem: ReturnType<typeof made>['filesystem'];
        let root: string;

        beforeEach(() => {
            ({ filesystem, root } = made());
        });
        afterEach(() => filesystem.remove(root));

        it('copies a directory with its empty directories, and an empty directory too', () => {
            filesystem.makeDirectory(join(root, 'from', 'empty'));
            filesystem.writeFile(join(root, 'from', 'kept.txt'), 'kept');
            filesystem.makeDirectory(join(root, 'nothing'));

            filesystem.copy(join(root, 'from'), join(root, 'to'));
            filesystem.copy(join(root, 'nothing'), join(root, 'also-nothing'));

            expect(filesystem.exists(join(root, 'to', 'empty'))).toBe(true);
            expect(filesystem.readFile(join(root, 'to', 'kept.txt'))).toBe('kept');
            expect(filesystem.exists(join(root, 'also-nothing'))).toBe(true);
        });
    });

    describe('in memory, for the session store and the calibration\'s files', () => {

        const key = { round: 'focus', run: 'aaaaaaaa', repeat: 1 };
        const identity = JudgeIdentity.of('kiro', 'claude-sonnet-5.5', 'kiro-cli 3.5.0');
        const verdicts = JudgeVerdicts.read(JSON.stringify({ verdicts: [ { rule: 'awaiting', verdict: 'pass', evidence: [ 'after/a.ts:1: a' ], reason: 'Awaited.' } ] }), [ 'awaiting' ], 'verdicts.json');
        const session = JudgeSession.of([ JudgeAttempt.of({ exitCode: 0, durationMs: 10, timedOut: false }, { credits: 0.5, models: [ 'claude-sonnet-5.5' ] }, verdicts) ]);

        it('saves a session, with its verdicts, and finds it again by its fingerprint only', () => {
            const filesystem = new MemoryFilesystem();
            const { sessions } = new CalibrationFiles('/out', filesystem);

            sessions.save(key, Fingerprint.of('abc'), identity, session);

            expect([ ...filesystem.files.keys() ]).toEqual([ '/out/calibration/sessions/focus/aaaaaaaa/1/session.json', '/out/calibration/sessions/focus/aaaaaaaa/1/verdicts.json' ]);
            expect(JSON.parse(filesystem.readFile('/out/calibration/sessions/focus/aaaaaaaa/1/session.json')!)).toMatchObject({ fingerprint: 'abc', judge: identity.toJSON() });
            expect(sessions.find(key, Fingerprint.of('abc'))?.verdicts?.map(verdict => verdict.rule)).toEqual([ 'awaiting' ]);
            expect(sessions.find(key, Fingerprint.of('other'))).toBeUndefined();
            expect(sessions.find({ ...key, repeat: 2 }, Fingerprint.of('abc'))).toBeUndefined();
        });

        it('clears a session that is to be judged again, and only that one', () => {
            const filesystem = new MemoryFilesystem();
            const { sessions } = new CalibrationFiles('/out', filesystem);
            sessions.save(key, Fingerprint.of('abc'), identity, session);
            sessions.save({ ...key, repeat: 2 }, Fingerprint.of('abc'), identity, session);

            sessions.clear(key);

            expect(sessions.find(key, Fingerprint.of('abc'))).toBeUndefined();
            expect(sessions.find({ ...key, repeat: 2 }, Fingerprint.of('abc'))).toBeDefined();
        });

        it('writes the report, as calibration.json and calibration.md', () => {
            const filesystem = new MemoryFilesystem();
            const files = new CalibrationFiles('/out', filesystem);
            const protocol = new CalibrationProtocol();
            const report = CalibrationReport.of([], { items: [], protocol, judge: identity, sessions: { sessions: 0, withoutVerdicts: 0, retried: 0, credits: 0, durationMs: 0 }, withoutProject: [] });

            files.saveReport(report, [], protocol);

            expect(JSON.parse(filesystem.readFile('/out/calibration/calibration.json')!)).toMatchObject({ judge: identity.toJSON(), entries: [] });
            expect(filesystem.readFile('/out/calibration/calibration.md')).toContain('# Calibrating the judge');
        });
    });
});
