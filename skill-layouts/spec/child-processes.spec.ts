import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandDidNotStart, complete, run, runBuffer, startDaemon } from '../src/child-processes.ts';
import type { ChecksSandbox } from '../src/sandbox.ts';

describe('child processes', () => {

    let directory: string;
    const script = (name: string, body: string) => {
        const file = join(directory, name);
        writeFileSync(file, `#!/bin/sh\n${ body }\n`, { mode: 0o755 });
        return file;
    };

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'skill-layouts-child-processes-'));
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    describe('run', () => {

        it('returns what the command printed, in the directory and with the environment it is given', () => {
            expect(run('/bin/sh', [ '-c', 'echo "$PWD $GREETING"' ], { cwd: directory, env: { GREETING: 'hello' } }).trim())
                .toMatch(new RegExp(`${ directory.split('/').pop() } hello$`));
        });

        it("throws Node's own error when the command fails, with its status, stdout and stderr, as project.ts reads them", () => {
            const failing = script('failing', 'echo out; echo err >&2; exit 3');

            expect(() => run(failing, [], { stdio: [ 'ignore', 'pipe', 'pipe' ] })).toThrow(expect.objectContaining({ status: 3, stdout: 'out\n', stderr: 'err\n' }));
        });

        it("throws Node's own error when the command can't start", () => {
            expect(() => run(join(directory, 'no-such-command'), [])).toThrow(expect.objectContaining({ code: 'ENOENT' }));
        });
    });

    describe('runBuffer', () => {

        it('returns what the command printed as bytes, and gives it its input', () => {
            const output = runBuffer('/bin/cat', [], { input: Buffer.from([ 0, 1, 2 ]) });

            expect(Buffer.isBuffer(output)).toBe(true);
            expect([ ...output ]).toEqual([ 0, 1, 2 ]);
        });
    });

    describe('complete', () => {

        const options = () => ({ cwd: directory, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 10_000 });

        it("returns a command's stdout when it succeeds, and nothing of its stderr", () => {
            expect(complete('/bin/sh', [ '-c', 'echo out; echo err >&2' ], options()))
                .toEqual({ failed: false, timedOut: false, status: 0, signal: null, stdout: 'out\n', stderr: '' });
        });

        it('returns the status, stdout and stderr of a command that fails, without throwing', () => {
            expect(complete('/bin/sh', [ '-c', 'echo out; echo err >&2; exit 3' ], options()))
                .toEqual({ failed: true, timedOut: false, status: 3, signal: null, stdout: 'out\n', stderr: 'err\n' });
        });

        it('says a command its timeout stopped timed out, with the signal that stopped it', () => {
            expect(complete('/bin/sleep', [ '5' ], { ...options(), timeoutMs: 200 })).toMatchObject({ failed: true, timedOut: true, signal: 'SIGTERM' });
        });

        it("throws CommandDidNotStart, naming the command, when it can't start", () => {
            expect(() => complete(join(directory, 'no-such-command'), [], options())).toThrow(CommandDidNotStart);
            expect(() => complete(join(directory, 'no-such-command'), [], options())).toThrow(/^couldn't start .*no-such-command: .*ENOENT/);
        });

        describe('in a sandbox', () => {

            // a sandbox that runs the command through sh, and refuses with 71 and "refused: <reason>"
            const sandbox = (): ChecksSandbox => ({
                problems: () => [],
                wrap: (command, args) => ({ command: '/bin/sh', args: [ '-c', '"$0" "$@"', command, ...args ] }),
                refusalOf: (status, stderr) => status === 71 ? /^refused: .*$/m.exec(stderr)?.[0] : undefined,
            });
            const paths = { writable: [], readable: [], home: '/nowhere' };

            it('runs the command as the sandbox wraps it', () => {
                expect(complete('/bin/echo', [ 'inside' ], { ...options(), sandbox: { checks: sandbox(), paths } })).toMatchObject({ failed: false, stdout: 'inside\n' });
            });

            it("throws CommandDidNotStart, naming the command and the sandbox's reason, when the sandbox refuses it", () => {
                const refused = script('refused', 'echo "refused: no profile" >&2; exit 71');

                expect(() => complete(refused, [], { ...options(), sandbox: { checks: sandbox(), paths } })).toThrow(new CommandDidNotStart(`couldn't start ${ refused }: refused: no profile`));
            });

            it('returns a failure that exits with the refusal status, when the sandbox says it was no refusal', () => {
                const failing = script('failing', 'echo "something else" >&2; exit 71');

                expect(complete(failing, [], { ...options(), sandbox: { checks: sandbox(), paths } })).toMatchObject({ failed: true, status: 71, stderr: 'something else\n' });
            });
        });
    });

    describe('startDaemon', () => {

        it('collects what it prints, says which output printed each chunk, and stops it', async () => {
            const daemon = startDaemon(process.execPath, [ '-e', "process.stdout.write('ready'); process.stderr.write('warning'); setInterval(() => {}, 1000)" ]);
            const chunks: string[] = [];
            daemon.onOutput((chunk, stream) => chunks.push(`${ stream }: ${ chunk }`));

            await new Promise<void>(resolve => {
                const waiting = setInterval(() => {
                    if (daemon.output().includes('ready') && daemon.output().includes('warning')) {
                        clearInterval(waiting);
                        resolve();
                    }
                }, 10);
            });
            await daemon.stop();

            // Node itself may print warnings of its own, on stderr, in some environments
            expect(chunks).toEqual(expect.arrayContaining([ 'stderr: warning', 'stdout: ready' ]));
            expect(await daemon.exited).toBeNull();
        });

        it('resolves exited with the exit code of a daemon that exits by itself', async () => {
            const daemon = startDaemon(process.execPath, [ '-e', 'process.exit(4)' ]);

            expect(await daemon.exited).toBe(4);
        });
    });
});
