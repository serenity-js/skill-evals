// Reads the event streams of Kiro and GitHub Copilot CLI: which skill files each run read, and what it cost.
//
// Copilot's JSONL, from `copilot -p --output-format json`, has the session events that the Copilot SDK documents at
// https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/streaming-events: each a `type` and a `data`
// payload, such as tool.execution_start and tool.execution_complete, and a final `result` record. Kiro's format isn't
// documented, beyond "one JSON object per line"; parseKiroStream follows the streams the pilot recorded, which are
// the Agent Client Protocol (ACP) in JSONL. Both parsers refuse a stream they don't recognise, so a format that differs
// from what they assume stops the scoring instead of counting as a run that read no skills. A read only counts when
// its tool call succeeded: a tool.execution_complete with `success: true`, and exit code 0 for a shell command, in
// Copilot's stream; a tool call whose last status is completed in Kiro's. The Kiro fixtures are the pilot's streams,
// trimmed. Copilot's recorded streams are copilot-cli.smoke-e3c01675.jsonl, a run with tool calls under Copilot 1.0.114,
// and copilot-cli.smoke-349396b6.jsonl, a session that failed before it started. copilot-cli.synthetic.jsonl is written
// by hand, in the recorded events' shapes, and keeps what 1.0.114 doesn't send but its documentation does:
// assistant.usage events, with their tokens. 1.0.114 names the model in model.call_start and
// session.auto_mode_resolved instead, and reports no tokens.
import type { SkillDirectories } from './skill-directories.ts';

export type ReadVia = 'read' | 'skill-tool' | 'shell';

export interface SkillRead {
    /** The skill file, as `<skill>/<file>`, e.g. `serenity-js-screenplay/references/tasks.md` */
    file: string;
    via: ReadVia;
}

export interface Tokens {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
}

export interface AutoMode {
    chosenModel: string;
    /** The models the plan has: with more than one, the choice mattered */
    availableModels: string[];
}

export interface Trace {
    skillReads: SkillRead[];
    tokens: Tokens;
    /**
     * Every model the stream says answered the run, in the order it first names them; none when it doesn't say.
     * With a pin of "auto", the agent picks the model, and may pick more than one, such as for a subagent.
     */
    models: string[];
    /** Whether a model answered at all: for Copilot, at least one assistant.usage or assistant.message event */
    modelAnswered: boolean;
    /** The agent's version, when the stream records it, or '' */
    agentVersion: string;
    /** What the agent estimates the run cost, in US dollars, or `undefined` when its stream doesn't report a cost */
    costUsd: number | undefined;
    /** Whether the stream reports tokens; Kiro's doesn't, so its tokens stay 0 */
    tokensReported: boolean;
    /** The credits the session used, as Kiro reports them, or `undefined` for an agent that doesn't */
    credits: number | undefined;
    /** Copilot's premium requests, from its result record, or `undefined` for an agent that doesn't report them */
    premiumRequests: number | undefined;
    /** Copilot's total nano AIUs, as its last session.usage_checkpoint reports them, unconverted, or `undefined` */
    totalNanoAiu: number | undefined;
    /** What Copilot's auto mode chose, and the models it could choose from, when the pin is "auto" and the stream says */
    autoMode: AutoMode | undefined;
    /** How many tool calls completed, or succeeded */
    completedToolCalls: number;
    /** The shell commands of the calls that completed, in order */
    shellCommands: string[];
    /** What the agent said at the end, after its last tool call, such as its report and suggestions, or '' */
    reply: string;
}

interface ToolCall {
    name: string;
    input: Record<string, unknown>;
    /** The call got a result, and the result isn't an error */
    succeeded: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Skill files: the files in the skill directories a parser is given, which skill-directories.ts recognises

// the commands that print a file's contents; sed only with -n, which prints the lines it selects
const READERS = new Set([ 'cat', 'head', 'tail', 'less', 'more', 'bat' ]);

function readsContents(segment: string): boolean {
    const words = segment.trim().split(/\s+/).filter(word => ! /^\w+=/.test(word));
    const [ command, ...args ] = words;
    return READERS.has(command) || (command === 'sed' && args.includes('-n') && ! args.some(arg => /^-i/.test(arg)));
}

/**
 * The skill files a shell command reads the contents of, with `cat`, `head`, `tail`, `less`, `more`, `bat` or
 * `sed -n`. Listing or testing a file, with `ls`, `find` or `test -f`, doesn't read it, and neither does a glob.
 */
export function skillFilesIn(command: string, skills: SkillDirectories): string[] {
    return command.split(/&&|\|\||[;|\n]/).filter(readsContents).flatMap(segment => skills.filesIn(segment));
}

function pathsOf(input: Record<string, unknown>): string[] {
    const paths: unknown[] = [ input.path, input.file_path, ...(Array.isArray(input.paths) ? input.paths : []) ];
    if (Array.isArray(input.operations)) {
        paths.push(...input.operations.map(operation => (operation as Record<string, unknown>)?.path));
    }
    return paths.filter((path): path is string => typeof path === 'string');
}

function skillReadsOf(call: ToolCall, tools: { read: string[], shell: string[], skill: string[] }, skills: SkillDirectories): SkillRead[] {
    if (! call.succeeded) {
        return [];
    }
    if (tools.skill.includes(call.name)) {
        const name = call.input.skill ?? call.input.name ?? call.input.command;
        return typeof name === 'string' ? [ { file: `${ name.replace(/^\//, '') }/SKILL.md`, via: 'skill-tool' } ] : [];
    }
    if (tools.read.includes(call.name)) {
        return pathsOf(call.input).flatMap(path => skills.fileIn(path) ?? []).map(file => ({ file, via: 'read' }));
    }
    if (tools.shell.includes(call.name) && typeof call.input.command === 'string') {
        return skillFilesIn(call.input.command, skills).map(file => ({ file, via: 'shell' }));
    }
    return [];
}

function jsonLines(stream: string): Record<string, unknown>[] {
    return stream.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>);
}

const number = (value: unknown): number => typeof value === 'number' ? value : 0;
const text = (value: unknown): string => typeof value === 'string' ? value : '';

// ---------------------------------------------------------------------------------------------------------------------
// Kiro

// Kiro's stream-json is the Agent Client Protocol in JSONL: a runStarted with payloadSchema "acp", then sessionUpdate
// events, whose data.update is an ACP session update, then runFinished. A tool call is a tool_call, then tool_call_update
// events with the same toolCallId, each carrying the fields that changed: title, kind (read, execute, edit, search),
// rawInput and status. Loading a skill is a call whose rawInput.id is "skill::<name>".

type Update = Record<string, unknown>;

const KIRO_SKILL = /^skill::(.+)$/;

/** The SKILL.md a call loaded, from the context Kiro disclosed for it, e.g. `file:///…/.kiro/skills/<skill>/SKILL.md`. */
function disclosedSkillOf(update: Update, skills: SkillDirectories): string | undefined {
    const context = ((((update._meta ?? {}) as Update).kiro ?? {}) as Update).disclosedContext as Update | undefined;
    if (context?.type !== 'skill' || typeof context.uri !== 'string') {
        return undefined;
    }
    const path = context.uri.startsWith('file://') ? decodeURIComponent(new URL(context.uri).pathname) : context.uri;
    return skills.fileIn(path);
}

/**
 * The skill a load names in its rawInput: `{ id: 'skill::<name>' }`, as Kiro 3.3.0 wrote it in the first pilots, or
 * `{ name: '<name>' }`, as it wrote it in a later smoke run. Only a rawInput that holds nothing but the name counts,
 * so another tool's `name` isn't taken for a skill.
 */
function namedSkillOf(input: Record<string, unknown>): string | undefined {
    const skill = KIRO_SKILL.exec(text(input.id))?.[1]
        ?? (Object.keys(input).length === 1 && typeof input.name === 'string' && input.name ? input.name : undefined);
    return skill && `${ skill }/SKILL.md`;
}

/**
 * The skill files a completed call read. A skill load counts once: by the SKILL.md Kiro disclosed for the call, the
 * primary signal, or else by the skill its rawInput names.
 */
function kiroSkillReads(call: Update, disclosed: string | undefined, skills: SkillDirectories): SkillRead[] {
    const input = (call.rawInput ?? {}) as Record<string, unknown>;
    const skill = disclosed ?? namedSkillOf(input);
    if (skill) {
        return [ { file: skill, via: 'skill-tool' } ];
    }
    if (call.kind === 'read') {
        return pathsOf(input).flatMap(path => skills.fileIn(path) ?? []).map(file => ({ file, via: 'read' as const }));
    }
    if (call.kind === 'execute' && typeof input.command === 'string') {
        return skillFilesIn(input.command, skills).map(file => ({ file, via: 'shell' as const }));
    }
    return [];
}

/** What Kiro did, from its stream-json, with its reads of the files in `skills` as its skill reads. */
export function parseKiroStream(stream: string, skills: SkillDirectories): Trace {
    const events = jsonLines(stream);
    const data = (event: Record<string, unknown>) => (event.data ?? {}) as Record<string, unknown>;
    const updates = events.filter(event => event.type === 'sessionUpdate').map(event => (data(event).update ?? {}) as Update);
    const isAcp = events.some(event => event.type === 'runStarted' && data(event).payloadSchema === 'acp');
    if (! isAcp || updates.length === 0) {
        throw new Error(`the stream doesn't look like Kiro's ACP stream-json: it needs a runStarted with payloadSchema "acp", and session updates, and it has ${ isAcp ? 'no session updates' : 'no such runStarted' } among its ${ events.length } events`);
    }

    // each call's fields, as the last update that carried them left them, in the order the calls started
    const calls = new Map<string, Update>();
    for (const update of updates.filter(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
        const id = text(update.toolCallId);
        calls.set(id, { ...calls.get(id), ...Object.fromEntries(Object.entries(update).filter(([ , value ]) => value !== undefined)) });
    }

    const models = updates
        .filter(update => update.sessionUpdate === 'config_option_update')
        .map(update => ((update.configOptions ?? []) as Update[]).find(option => option.id === 'model')?.currentValue)
        .filter((model): model is string => typeof model === 'string');

    const usage = updates
        .map(update => ((update._meta as Update | undefined)?.kiro ?? {}) as Update)
        .filter(meta => meta.kind === 'session_usage')
        .map(meta => ((meta.credits ?? []) as Update[])[0]?.usage)
        .filter((credits): credits is number => typeof credits === 'number');

    // the SKILL.md each call loaded, from whichever of its updates disclosed it; an approval that's only pending doesn't count
    const disclosures = new Map<string, string>();
    for (const update of updates.filter(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
        const skill = disclosedSkillOf(update, skills);
        if (skill) {
            disclosures.set(text(update.toolCallId), skill);
        }
    }

    const completed = [ ...calls.values() ].filter(call => call.status === 'completed');

    // the message the agent streamed in chunks after its last tool call
    const lastCall = updates.findLastIndex(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update');
    const reply = updates.slice(lastCall + 1)
        .filter(update => update.sessionUpdate === 'agent_message_chunk')
        .map(update => text(((update.content ?? {}) as Update).text))
        .join('')
        .trim();

    return {
        reply,
        skillReads: completed.flatMap(call => kiroSkillReads(call, disclosures.get(text(call.toolCallId)), skills)),
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        tokensReported: false,
        credits: usage.at(-1),
        premiumRequests: undefined,
        totalNanoAiu: undefined,
        autoMode: undefined,
        completedToolCalls: completed.length,
        shellCommands: completed
            .filter(call => call.kind === 'execute')
            .map(call => text(((call.rawInput ?? {}) as Record<string, unknown>).command))
            .filter(Boolean),
        models: models.length > 0 ? [ models.at(-1)! ] : [],
        // Kiro's stream names the model it answers with in a configuration update, and has no other sign of an answer
        modelAnswered: models.length > 0,
        agentVersion: '',
        costUsd: undefined,
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub Copilot CLI

const COPILOT_TOOLS = {
    read: [ 'view' ],
    shell: [ 'bash', 'powershell' ],
    skill: [ 'skill' ],
};

// how Copilot's shell tools end their result, e.g. "<shellId: 2 completed with exit code 128>"
const COPILOT_EXIT_CODE = /<shellId: \d+ completed with exit code (\d+)>/;

// what Copilot's view tool answers, with success: true, when the file is too big to show, e.g. "File too large to read at once (25.1 KB). Consider ..."
const COPILOT_FILE_TOO_LARGE = /^File too large to read at once/;

/**
 * A completed call that succeeded, and, for a shell command, exited with 0. A view that only says the file is too
 * large shows the agent none of it, so it didn't succeed either. Copilot reports `success: true` for a
 * command that ran, whatever it exited with; the exit code is in `shellExecution.exitCode`, and ends the result's text.
 */
function isCopilotSuccess(complete: Record<string, unknown>, toolName: string): boolean {
    const content = text((complete.result as Record<string, unknown> | undefined)?.content);
    if (COPILOT_TOOLS.read.includes(toolName) && COPILOT_FILE_TOO_LARGE.test(content)) {
        return false;
    }
    const reported = (complete.shellExecution as Record<string, unknown> | undefined)?.exitCode;
    const exitCode = typeof reported === 'number' ? reported : Number(COPILOT_EXIT_CODE.exec(content)?.[1] ?? 0);
    return complete.success === true && exitCode === 0;
}

/**
 * What Copilot did, from its JSONL, with its reads of the files in `skills` as its skill reads. A stream without its
 * final result record ended early, which only a timeout explains: with `timedOut`, it's scored as far as it goes;
 * without, it stops the scoring.
 */
export function parseCopilotStream(stream: string, { timedOut = false, skills }: { timedOut?: boolean, skills: SkillDirectories }): Trace {
    const events = jsonLines(stream);
    const data = (event: Record<string, unknown>) => (event.data ?? {}) as Record<string, unknown>;
    if (! events.some(event => [ 'session.start', 'tool.execution_start', 'assistant.message' ].includes(text(event.type)))) {
        throw new Error(`the stream doesn't look like Copilot's JSONL: none of its ${ events.length } events is a session.start, tool.execution_start or assistant.message`);
    }
    if (! timedOut && ! events.some(event => event.type === 'result')) {
        throw new Error('the Copilot stream has no result record, so the run ended before it finished');
    }
    // a session.error, such as a model that isn't available, ends the session with a result record too
    const errors = events.filter(event => event.type === 'session.error').map(event => text(data(event).message) || 'no message');
    if (errors.length > 0) {
        throw new Error(`the Copilot session failed: ${ errors.join('; ') }`);
    }

    const start = events.find(event => event.type === 'session.start');
    const result = events.find(event => event.type === 'result');
    const toolNames = new Map(events
        .filter(event => event.type === 'tool.execution_start')
        .map(event => [ text(data(event).toolCallId), text(data(event).toolName) ]));
    const completed = new Map(events
        .filter(event => event.type === 'tool.execution_complete')
        .map(event => [ text(data(event).toolCallId), isCopilotSuccess(data(event), toolNames.get(text(data(event).toolCallId)) ?? '') ]));
    const calls: ToolCall[] = events
        .filter(event => event.type === 'tool.execution_start')
        .map(event => ({
            name: text(data(event).toolName),
            input: (data(event).arguments ?? {}) as Record<string, unknown>,
            succeeded: completed.get(text(data(event).toolCallId)) === true,
        }));
    const usage = events.filter(event => event.type === 'assistant.usage').map(data);
    // the Copilot SDK documents assistant.usage's `model` as the one that served the API call, but 1.0.114 sends no usage
    // events. session.start's selectedModel is only the one the harness asked for, which, with "auto", says nothing
    // about the one that answered
    // Copilot 1.0.114 sends none, and names the model in each model.call_start instead; usage events are the fallback
    const distinct = (names: string[]) => [ ...new Set(names.filter(Boolean)) ];
    const called = distinct(events.filter(event => event.type === 'model.call_start').map(event => text(data(event).model)));
    const models = called.length > 0 ? called : distinct(usage.map(call => text(call.model)));
    const resolved = events.find(event => event.type === 'session.auto_mode_resolved');
    const checkpoint = events.findLast(event => event.type === 'session.usage_checkpoint');
    // what the agent said after its last tool call, as for Kiro: a progress message before it isn't the final reply
    const lastCall = events.findLastIndex(event => event.type === 'tool.execution_start' || event.type === 'tool.execution_complete');
    const messages = events.slice(lastCall + 1)
        .filter(event => event.type === 'assistant.message').map(event => text(data(event).content).trim()).filter(Boolean);

    return {
        reply: messages.at(-1) ?? '',
        skillReads: calls.flatMap(call => skillReadsOf(call, COPILOT_TOOLS, skills)),
        tokens: {
            input: usage.reduce((total, call) => total + number(call.inputTokens), 0),
            cacheRead: usage.reduce((total, call) => total + number(call.cacheReadTokens), 0),
            cacheWrite: usage.reduce((total, call) => total + number(call.cacheWriteTokens), 0),
            output: usage.reduce((total, call) => total + number(call.outputTokens), 0),
        },
        tokensReported: usage.length > 0,
        credits: undefined,
        premiumRequests: typeof ((result?.usage ?? {}) as Record<string, unknown>).premiumRequests === 'number'
            ? ((result!.usage as Record<string, unknown>).premiumRequests as number) : undefined,
        completedToolCalls: calls.filter(call => call.succeeded).length,
        shellCommands: calls
            .filter(call => call.succeeded && COPILOT_TOOLS.shell.includes(call.name) && typeof call.input.command === 'string')
            .map(call => call.input.command as string),
        models,
        modelAnswered: events.some(event => [ 'assistant.usage', 'assistant.message' ].includes(text(event.type))),
        agentVersion: text(start && data(start).copilotVersion),
        totalNanoAiu: typeof (checkpoint && data(checkpoint).totalNanoAiu) === 'number' ? data(checkpoint!).totalNanoAiu as number : undefined,
        autoMode: resolved && {
            chosenModel: text(data(resolved).chosenModel),
            availableModels: Array.isArray(data(resolved).availableModels) ? (data(resolved).availableModels as unknown[]).filter((model): model is string => typeof model === 'string') : [],
        },
        // the result record reports premium requests, not a cost
        costUsd: undefined,
    };
}
