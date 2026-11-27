import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { harnessSkillDirectories } from '../src/harness-skills.ts';
import { parseCopilotStream, parseKiroStream, skillFilesIn } from '../src/streams.ts';

const skills = harnessSkillDirectories();
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');

describe('streams', () => {

    describe('skillFileIn', () => {
        it.each([
            [ '/runs/x/.kiro/skills/serenity-js-screenplay/tasks.md',                 'serenity-js-screenplay/tasks.md' ],
            [ '/runs/x/.kiro/skills/serenity-js-screenplay/references/tasks.md',      'serenity-js-screenplay/references/tasks.md' ],
            [ '.claude/skills/serenity-js-writing-tasks/SKILL.md',                    'serenity-js-writing-tasks/SKILL.md' ],
            [ '/runs/x/.agents/skills/serenity-js-writing-questions/SKILL.md',        'serenity-js-writing-questions/SKILL.md' ],
            [ 'node_modules/@serenity-js/core/skills/serenity-js-screenplay/SKILL.md', 'serenity-js-screenplay/SKILL.md' ],
            [ 'C:\\runs\\x\\.claude\\skills\\serenity-js-writing-tasks\\SKILL.md',    'serenity-js-writing-tasks/SKILL.md' ],
            [ '/runs/x/.github/skills/serenity-js-writing-tasks/SKILL.md',            'serenity-js-writing-tasks/SKILL.md' ],
        ])('finds the skill file in %s', (path, expected) => {
            expect(skills.fileIn(path)).toBe(expected);
        });

        it.each([
            '/runs/x/spec/math-js_api.spec.ts',
            '/runs/x/.kiro/skills/serenity-js-screenplay',
            '/runs/x/skills/serenity-js-screenplay/SKILL.md',
        ])('finds none in %s', path => {
            expect(skills.fileIn(path)).toBeUndefined();
        });
    });

    describe('skillFilesIn a shell command', () => {
        it.each([
            [ 'cat .kiro/skills/serenity-js-screenplay/SKILL.md .kiro/skills/serenity-js-screenplay/tasks.md | head', [ 'serenity-js-screenplay/SKILL.md', 'serenity-js-screenplay/tasks.md' ] ],
            [ 'head -50 .claude/skills/serenity-js-writing-tasks/SKILL.md',                                      [ 'serenity-js-writing-tasks/SKILL.md' ] ],
            [ 'tail -n 20 .claude/skills/serenity-js-writing-tasks/SKILL.md',                                    [ 'serenity-js-writing-tasks/SKILL.md' ] ],
            [ 'less .claude/skills/serenity-js-writing-tasks/SKILL.md',                                          [ 'serenity-js-writing-tasks/SKILL.md' ] ],
            [ 'more .claude/skills/serenity-js-writing-tasks/SKILL.md',                                          [ 'serenity-js-writing-tasks/SKILL.md' ] ],
            [ 'bat .claude/skills/serenity-js-writing-tasks/SKILL.md',                                           [ 'serenity-js-writing-tasks/SKILL.md' ] ],
            [ "sed -n '1,80p' node_modules/@serenity-js/core/skills/serenity-js-writing-questions/SKILL.md",     [ 'serenity-js-writing-questions/SKILL.md' ] ],
            [ 'cd /runs/x && cat .kiro/skills/serenity-js-screenplay/tasks.md',                                  [ 'serenity-js-screenplay/tasks.md' ] ],
        ])('finds the skill files that %s reads', (command, expected) => {
            expect(skillFilesIn(command, skills)).toEqual(expected);
        });

        it.each([
            'ls .kiro/skills/serenity-js-screenplay/tasks.md',
            'find .kiro/skills -name tasks.md -path "*/serenity-js-screenplay/tasks.md"',
            'test -f .kiro/skills/serenity-js-screenplay/tasks.md && echo yes',
            '[ -e .kiro/skills/serenity-js-screenplay/tasks.md ]',
            'wc -l .kiro/skills/serenity-js-screenplay/tasks.md',
            "sed -i 's/a/b/' .kiro/skills/serenity-js-screenplay/tasks.md",
            'echo .kiro/skills/serenity-js-screenplay/tasks.md',
            'ls .kiro/skills/serenity-js-screenplay && cat .kiro/skills/*/SKILL.md',
        ])("finds none in %s, which doesn't read the file's contents", command => {
            expect(skillFilesIn(command, skills)).toEqual([]);
        });
    });

    describe('parseKiroStream', () => {
        // the pilot's streams, of layout B with request 4, and of layout None with request 1, trimmed
        const layoutB = parseKiroStream(fixture('kiro-v3.pilot-8e3a4613.jsonl'), skills);
        const none = parseKiroStream(fixture('kiro-v3.pilot-6a069239.jsonl'), skills);

        it('records the skills the agent loaded, and the supporting files it read', () => {
            expect(layoutB.skillReads).toEqual([
                { file: 'serenity-js-writing-tests/SKILL.md', via: 'skill-tool' },
                { file: 'serenity-js-screenplay/SKILL.md', via: 'skill-tool' },
                { file: 'serenity-js-screenplay/questions.md', via: 'read' },
            ]);
        });

        it('counts the tool calls that completed, and lists the shell commands among them', () => {
            expect(layoutB.completedToolCalls).toBe(11);
            expect(layoutB.shellCommands).toEqual([
                expect.stringMatching(/^npx mocha spec\/frankfurter_api\.spec\.ts/),
                expect.stringMatching(/^npx eslint spec\/frankfurter_api\.spec\.ts/),
            ]);
            expect(layoutB.premiumRequests).toBeUndefined();
        });

        it('records no skill reads for a run without skills, though it read other files', () => {
            expect(none.skillReads).toEqual([]);
        });

        it('records the model from the last configuration update, rather than the "auto" Kiro starts with', () => {
            expect(layoutB.models).toEqual([ 'claude-sonnet-5.5' ]);
            expect(none.models).toEqual([ 'claude-sonnet-5.5' ]);
        });

        it('records the credits the session used, and no tokens, which Kiro reports none of', () => {
            expect(layoutB.credits).toBeCloseTo(1.0746, 4);
            expect(layoutB.tokensReported).toBe(false);
            expect(layoutB.tokens).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
            expect(layoutB.costUsd).toBeUndefined();
        });

        const acp = (...updates: Array<Record<string, unknown>>) => [
            { type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v3' } },
            ...updates.map(update => ({ type: 'sessionUpdate', data: { sessionId: 's', update } })),
            { type: 'runFinished', data: { sessionId: 's', status: 'success' } },
        ].map(event => JSON.stringify(event)).join('\n');
        const call = (id: string, fields: Record<string, unknown>, ...statuses: string[]) => [
            { sessionUpdate: 'tool_call', toolCallId: id, ...fields },
            ...statuses.map(status => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status })),
        ];

        it.each([
            [ 'a skill load that failed',    call('t1', { title: 'Load skill', rawInput: { id: 'skill::serenity-js-writing-tasks' } }, 'in_progress', 'failed') ],
            [ 'a read that never completed', call('t1', { kind: 'read', rawInput: { path: '/r/.kiro/skills/serenity-js-writing-tasks/SKILL.md' } }, 'in_progress') ],
            [ 'a listing of a skill file',   call('t1', { kind: 'execute', rawInput: { command: 'ls .kiro/skills/serenity-js-writing-tasks/SKILL.md' } }, 'completed') ],
        ])("doesn't count %s as a read", (_, updates) => {
            expect(parseKiroStream(acp(...updates), skills).skillReads).toEqual([]);
        });

        describe('skill loads', () => {

            // the smoke run of Kiro 3.3.0 whose skill load's rawInput was { name } rather than { id: 'skill::…' }, trimmed
            const smoke = parseKiroStream(fixture('kiro-v3.smoke-974a67ed.jsonl'), skills);

            const disclosed = (skill: string) => ({ _meta: { kiro: { toolId: 'disclose_context', disclosedContext: { type: 'skill', displayName: skill, uri: `file:///r/.kiro/skills/${ skill }/SKILL.md` } } } });
            const completedLoad = (id: string, rawInput: Record<string, unknown>, extra: Record<string, unknown> = {}) => [
                { sessionUpdate: 'tool_call', toolCallId: id, title: 'Load skill', rawInput },
                { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', title: 'Loaded skill', rawInput, ...extra },
            ];

            it("counts the smoke run's load of serenity-js-writing-tests, whose rawInput only names it, and its read of tasks.md", () => {
                expect(smoke.skillReads).toEqual([
                    { file: 'serenity-js-writing-tests/SKILL.md', via: 'skill-tool' },
                    { file: 'serenity-js-screenplay/tasks.md', via: 'read' },
                ]);
            });

            it("counts a load from the call's disclosed context, which names the skill's SKILL.md, whatever its rawInput says", () => {
                expect(parseKiroStream(acp(...completedLoad('t1', {}, disclosed('serenity-js-writing-tasks'))), skills).skillReads)
                    .toEqual([ { file: 'serenity-js-writing-tasks/SKILL.md', via: 'skill-tool' } ]);
            });

            it.each([
                [ 'an id',  { id: 'skill::serenity-js-writing-tasks' } ],
                [ 'a name', { name: 'serenity-js-writing-tasks' } ],
            ])('counts a completed load whose rawInput gives the skill as %s, when the call discloses no context', (_, rawInput) => {
                expect(parseKiroStream(acp(...completedLoad('t1', rawInput)), skills).skillReads)
                    .toEqual([ { file: 'serenity-js-writing-tasks/SKILL.md', via: 'skill-tool' } ]);
            });

            it('counts a load once, though both its disclosed context and its rawInput name the skill', () => {
                expect(parseKiroStream(acp(...completedLoad('t1', { name: 'serenity-js-writing-tasks' }, disclosed('serenity-js-writing-tasks'))), skills).skillReads)
                    .toEqual([ { file: 'serenity-js-writing-tasks/SKILL.md', via: 'skill-tool' } ]);
            });

            it("doesn't count a load that was only asked for, whose call never completed", () => {
                const asked = [
                    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Load skill', rawInput: { name: 'serenity-js-writing-tasks' } },
                    { sessionUpdate: 'session_info_update', _meta: { kiro: { pendingInteraction: { toolCallId: 't1', _meta: disclosed('serenity-js-writing-tasks')._meta } } } },
                ];

                expect(parseKiroStream(acp(...asked), skills).skillReads).toEqual([]);
            });

            it("doesn't take a name in the rawInput of another tool for a skill", () => {
                expect(parseKiroStream(acp(...completedLoad('t1', { name: 'serenity-js-writing-tasks', path: 'spec/x.spec.ts' })), skills).skillReads).toEqual([]);
            });
        });

        it("counts a call only by its last status, and a shell command that prints a skill's file", () => {
            const updates = [
                ...call('t1', { kind: 'execute', rawInput: { command: 'cat .kiro/skills/serenity-js-writing-tasks/SKILL.md' } }, 'in_progress', 'completed'),
                ...call('t2', { kind: 'read', rawInput: { path: '/r/.kiro/skills/serenity-js-writing-questions/SKILL.md' } }, 'completed', 'failed'),
            ];

            expect(parseKiroStream(acp(...updates), skills).skillReads).toEqual([ { file: 'serenity-js-writing-tasks/SKILL.md', via: 'shell' } ]);
        });

        it("refuses an AG-UI stream, though it has runStarted and runFinished, rather than scoring it as a run that read nothing", () => {
            const agui = [
                { type: 'runStarted', thread_id: 't', run_id: 'r' },
                { type: 'ToolCallStart', tool_call_id: 't1', tool_call_name: 'read_file' },
                { type: 'runFinished', run_id: 'r' },
            ].map(event => JSON.stringify(event)).join('\n');

            expect(() => parseKiroStream(agui, skills)).toThrow(/doesn't look like Kiro's ACP stream/);
        });

        it('refuses a stream that starts as ACP but has no session updates', () => {
            const empty = [ { type: 'runStarted', data: { payloadSchema: 'acp' } }, { type: 'runFinished', data: {} } ].map(event => JSON.stringify(event)).join('\n');

            expect(() => parseKiroStream(empty, skills)).toThrow(/doesn't look like Kiro's ACP stream/);
        });

        it("refuses Copilot's stream", () => {
            expect(() => parseKiroStream(fixture('copilot-cli.synthetic.jsonl'), skills)).toThrow(/doesn't look like Kiro's ACP stream/);
        });
    });

    describe('parseCopilotStream', () => {
        const trace = parseCopilotStream(fixture('copilot-cli.synthetic.jsonl'), { skills });

        it("records the skills the agent invoked, and the skill files it read and printed, including a subagent's, when the call succeeded", () => {
            expect(trace.skillReads).toEqual([
                { file: 'serenity-js-writing-tests/SKILL.md',      via: 'skill-tool' },
                { file: 'serenity-js-screenplay/references/tasks.md',         via: 'read' },
                { file: 'serenity-js-screenplay/references/questions.md',     via: 'shell' },
                { file: 'serenity-js-screenplay/SKILL.md',         via: 'read' },
            ]);
        });

        it('adds up the tokens of the usage events, when the stream has them', () => {
            expect(trace.tokens).toEqual({ input: 15_000, cacheRead: 75_000, cacheWrite: 2_500, output: 1_300 });
        });

        it('counts the tool calls that succeeded, lists the shell commands among them, and records the premium requests', () => {
            expect(trace.completedToolCalls).toBe(8);
            expect(trace.shellCommands).toEqual([ 'cat .agents/skills/serenity-js-screenplay/references/questions.md', 'ls .agents/skills/serenity-js-screenplay/references', 'npm test' ]);
            expect(trace.premiumRequests).toBe(1);
        });

        it('records the version of Copilot from the start of the session', () => {
            expect(trace.agentVersion).toBe('1.0.91');
        });

        // with a pin of "auto", Copilot picks the model, and session.start's selectedModel is only what the harness asked for
        it("records every model the usage events name, in the order they first appear, and not session.start's selectedModel", () => {
            expect(trace.models).toEqual([ 'claude-opus-5.5', 'gpt-5.4' ]);
        });

        it('records that a model answered, from a usage event or an assistant message', () => {
            expect(trace.modelAnswered).toBe(true);
            expect(parseCopilotStream(copilotStream('view', { path: 'x' }, { success: true }), { skills }).modelAnswered).toBe(false);
            expect(parseCopilotStream([
                { type: 'session.start', data: { selectedModel: 'auto' } },
                { type: 'assistant.message', data: { messageId: 'm1', content: 'Done.' } },
                { type: 'result', exitCode: 0, usage: { premiumRequests: 1 } },
            ].map(event => JSON.stringify(event)).join('\n'), { skills })).toMatchObject({ modelAnswered: true, models: [] });
        });

        it('names the models of model.call_start when the stream has no usage events, and prefers them to the usage events when it has both', () => {
            const events = (...more: object[]) => [
                { type: 'session.start', data: { selectedModel: 'auto' } },
                { type: 'model.call_start', data: { turnId: '0', model: 'gpt-6-luna' } },
                { type: 'model.call_start', data: { turnId: '1', model: 'gpt-6-luna' } },
                { type: 'model.call_start', data: { turnId: '2', model: 'claude-sonnet-5.5' } },
                { type: 'assistant.message', data: { messageId: 'm1', content: 'Done.' } },
                ...more,
                { type: 'result', exitCode: 0, usage: { premiumRequests: 1 } },
            ].map(event => JSON.stringify(event)).join('\n');

            expect(parseCopilotStream(events(), { skills }).models).toEqual([ 'gpt-6-luna', 'claude-sonnet-5.5' ]);
            expect(parseCopilotStream(events({ type: 'assistant.usage', data: { model: 'gpt-5.4' } }), { skills }).models).toEqual([ 'gpt-6-luna', 'claude-sonnet-5.5' ]);
        });

        describe('when the stream is a recorded one with tool calls, from Copilot 1.0.114 with a pin of "auto"', () => {
            const recorded = parseCopilotStream(fixture('copilot-cli.smoke-e3c01675.jsonl'), { skills });

            it('names the model from model.call_start, since the stream has no assistant.usage events', () => {
                expect(recorded.models).toEqual([ 'gpt-6-luna' ]);
                expect(recorded.modelAnswered).toBe(true);
            });

            it("records what Copilot's auto mode chose, and the models it could choose from", () => {
                expect(recorded.autoMode).toEqual({ chosenModel: 'gpt-6-luna', availableModels: [ 'gpt-6-luna' ] });
                expect(trace.autoMode).toBeUndefined();
            });

            it('reports no tokens, and keeps the usage checkpoint\'s nano AIUs next to the premium requests, as they are', () => {
                expect(recorded.tokensReported).toBe(false);
                expect(recorded.tokens).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
                expect(recorded.totalNanoAiu).toBe(523_059_500);
                expect(recorded.premiumRequests).toBe(1);
                expect(trace.totalNanoAiu).toBeUndefined();
            });

            it("counts the calls that succeeded, not the git status that exited with 128 though Copilot said success: true", () => {
                expect(recorded.completedToolCalls).toBe(12);
                expect(recorded.shellCommands).toEqual([
                    'cat .mocharc.yml',
                    "curl --fail --silent --show-error 'http://127.0.0.1:4170/v4?expr=1%20%2B%201'",
                    'npm test',
                    'npx eslint --config .eslintrc.js spec/math-js_api.spec.ts',
                ]);
            });

            it('finds the skill load, and the read of tasks.md with view_range, which the run made after its first view failed', () => {
                expect(recorded.skillReads).toEqual([
                    { file: 'serenity-js-writing-tests/SKILL.md', via: 'skill-tool' },
                    { file: 'serenity-js-screenplay/tasks.md', via: 'read' },
                ]);
            });

            describe("the run's first view of tasks.md, which Copilot answered with \"File too large to read at once\", and success: true", () => {
                const events = fixture('copilot-cli.smoke-e3c01675.jsonl').trim().split('\n').map(line => JSON.parse(line) as { type: string, data?: Record<string, unknown> });
                const first = events.find(event => event.type === 'tool.execution_start' && event.data?.toolName === 'view'
                    && String(event.data.arguments && (event.data.arguments as Record<string, unknown>).path).endsWith('serenity-js-screenplay/tasks.md'))!;
                const callId = first.data!.toolCallId;
                const justThatCall = parseCopilotStream([
                    ...events.filter(event => [ 'session.start', 'result' ].includes(event.type)),
                    ...events.filter(event => event.data?.toolCallId === callId),
                ].map(event => JSON.stringify(event)).join('\n'), { skills });

                it('is the call the recorded stream has, with no view_range', () => {
                    expect((first.data!.arguments as Record<string, unknown>).view_range).toBeUndefined();
                    expect(events.find(event => event.type === 'tool.execution_complete' && event.data?.toolCallId === callId)?.data)
                        .toMatchObject({ success: true, result: { content: expect.stringMatching(/^File too large to read at once \(25\.1 KB\)/) } });
                });

                it("isn't a skill read, because the agent saw none of the file", () => {
                    expect(justThatCall.skillReads).toEqual([]);
                });

                it("isn't a completed tool call", () => {
                    expect(justThatCall.completedToolCalls).toBe(0);
                });
            });

            it("takes the agent's last message as its reply", () => {
                expect(recorded.reply).toMatch(/^Added a Screenplay task and scenario/);
            });
        });

        describe('when the session failed', () => {
            const smoke = fixture('copilot-cli.smoke-349396b6.jsonl');

            it("refuses a stream with a session.error, and reports the error's message, even though it ends with a result record", () => {
                expect(() => parseCopilotStream(smoke, { skills })).toThrow('Model "claude-sonnet-5.5" is not available.');
                expect(() => parseCopilotStream(smoke, { skills })).toThrow(/the Copilot session failed/);
            });

            it('refuses it after a timeout too', () => {
                expect(() => parseCopilotStream(smoke, { timedOut: true, skills })).toThrow(/is not available/);
            });
        });

        const copilotStream = (name: string, args: Record<string, unknown>, complete: Record<string, unknown> | undefined) => [
            { type: 'session.start', data: { sessionId: 's', copilotVersion: '1.0.91', selectedModel: 'claude-opus-5.5' } },
            { type: 'tool.execution_start', data: { toolCallId: 'call_1', toolName: name, arguments: args } },
            ...(complete ? [ { type: 'tool.execution_complete', data: { toolCallId: 'call_1', ...complete } } ] : []),
            { type: 'result', exitCode: 0, usage: { premiumRequests: 1 } },
        ].map(event => JSON.stringify(event)).join('\n');

        it.each([
            [ 'a denied view',          'view',  { path: '.agents/skills/serenity-js-writing-tasks/SKILL.md' }, { success: false, error: { message: 'Permission denied', code: 'denied' } } ],
            [ 'a failed skill call',    'skill', { skill: 'serenity-js-writing-tasks' },                         { success: false, error: { message: 'Skill not found' } } ],
            [ 'a cat that exits with an error', 'bash', { command: 'cat .agents/skills/serenity-js-writing-tasks/SKILL.md' }, { success: true, shellExecution: { exitCode: 1 }, result: { content: 'No such file or directory\n<shellId: 0 completed with exit code 1>' } } ],
            [ 'a cat whose result only says how it exited', 'bash', { command: 'cat .agents/skills/serenity-js-writing-tasks/SKILL.md' }, { success: true, result: { content: 'No such file or directory\n<shellId: 0 completed with exit code 1>' } } ],
            [ 'a call without a result', 'view', { path: '.agents/skills/serenity-js-writing-tasks/SKILL.md' }, undefined ],
        ])("doesn't count %s as a read", (_, name, args, complete) => {
            expect(parseCopilotStream(copilotStream(name, args, complete), { skills }).skillReads).toEqual([]);
        });

        it('reads the name of the skill from the skill tool, whichever argument holds it', () => {
            expect(parseCopilotStream(copilotStream('skill', { name: 'serenity-js-writing-tasks' }, { success: true }), { skills }).skillReads)
                .toEqual([ { file: 'serenity-js-writing-tasks/SKILL.md', via: 'skill-tool' } ]);
        });

        it('refuses a stream without a result, which means the run ended early', () => {
            const truncated = fixture('copilot-cli.synthetic.jsonl').trim().split('\n').slice(0, -1).join('\n');

            expect(() => parseCopilotStream(truncated, { skills })).toThrow(/no result/);
        });

        it('scores a stream that a timeout cut off, without its result record, as far as it goes', () => {
            const cutOff = fixture('copilot-cli.synthetic.jsonl').trim().split('\n').slice(0, 9).join('\n');

            expect(parseCopilotStream(cutOff, { timedOut: true, skills }).skillReads).toEqual([
                { file: 'serenity-js-writing-tests/SKILL.md', via: 'skill-tool' },
                { file: 'serenity-js-screenplay/references/tasks.md', via: 'read' },
            ]);
            expect(() => parseCopilotStream(cutOff, { skills })).toThrow(/no result/);
        });

        it("refuses a stream it doesn't recognise, even after a timeout", () => {
            expect(() => parseCopilotStream('{"unexpected":true}', { timedOut: true, skills })).toThrow(/doesn't look like Copilot's JSONL/);
        });

        it("doesn't report a cost, which Copilot's stream has none of", () => {
            expect(parseCopilotStream(fixture('copilot-cli.synthetic.jsonl'), { skills }).costUsd).toBeUndefined();
        });

        it("refuses Kiro's stream, rather than scoring it as a run that read nothing", () => {
            expect(() => parseCopilotStream(fixture('kiro-v3.pilot-8e3a4613.jsonl'), { skills })).toThrow(/doesn't look like Copilot's JSONL/);
        });
    });

    describe("the agent's final reply", () => {

        const kiro = (...updates: object[]) => [
            { type: 'runStarted', data: { payloadSchema: 'acp' } },
            ...updates.map(update => ({ type: 'sessionUpdate', data: { update } })),
            { type: 'runFinished', data: {} },
        ].map(event => JSON.stringify(event)).join('\n');
        const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        const call = (toolCallId: string) => ({ sessionUpdate: 'tool_call', toolCallId, kind: 'read', status: 'completed', rawInput: { path: 'spec/x.spec.ts' } });

        it("is what Kiro said after its last tool call, joined from the stream's message chunks", () => {
            const stream = kiro(chunk("I'll read the spec. "), call('t1'), chunk('Added the scenario.\n\n'), chunk('Suggestions: replace PostAndCheck.'));

            expect(parseKiroStream(stream, skills).reply).toBe('Added the scenario.\n\nSuggestions: replace PostAndCheck.');
        });

        it("is empty when Kiro said nothing after its last tool call, as when a run timed out", () => {
            expect(parseKiroStream(kiro(chunk('Reading the spec.'), call('t1')), skills).reply).toBe('');
        });

        it("is Copilot's last assistant message that says something", () => {
            const stream = [
                { type: 'session.start', data: { selectedModel: 'claude-sonnet-5.5' } },
                { type: 'assistant.message', data: { messageId: 'm1', content: "I'll read the spec." } },
                { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'view', arguments: { path: 'spec/x.spec.ts' } } },
                { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: '...' } } },
                { type: 'assistant.message', data: { messageId: 'm2', content: 'Added the scenario. Suggestions: replace PostAndCheck.' } },
                { type: 'assistant.message', data: { messageId: 'm3', content: '' } },
                { type: 'result', usage: {} },
            ].map(event => JSON.stringify(event)).join('\n');

            expect(parseCopilotStream(stream, { skills }).reply).toBe('Added the scenario. Suggestions: replace PostAndCheck.');
        });

        it("is empty when Copilot said nothing after its last tool call, as when a run timed out after a progress message", () => {
            const stream = [
                { type: 'session.start', data: { selectedModel: 'claude-sonnet-5.5' } },
                { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'view', arguments: { path: 'spec/x.spec.ts' } } },
                { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: '...' } } },
                { type: 'assistant.message', data: { messageId: 'm1', content: "Now I'll add the scenario and run the tests." } },
                { type: 'tool.execution_start', data: { toolCallId: 'c2', toolName: 'bash', arguments: { command: 'npm test' } } },
                { type: 'result', usage: {} },
            ].map(event => JSON.stringify(event)).join('\n');

            expect(parseCopilotStream(stream, { skills }).reply).toBe('');
        });
    });
});
