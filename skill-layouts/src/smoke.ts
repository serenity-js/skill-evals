// The smoke run checks the harness, not the agents: one run per agent, in layout B, with a request that asks the agent
// to do each thing the harness has to see, so that each check shows whether the harness saw it. Run it for an agent
// before its first pilot. A check the agent's choices fail, such as a skill it didn't load, says so, apart from one
// the harness fails, such as a stream the parser read no tool calls from.
import type { Request } from './requests.ts';
import type { Agent } from './review.ts';
import { ENVIRONMENT_BASICS } from './runs.ts';
import type { SkillRead } from './streams.ts';

/** Kept out of requests.json, so the evaluation's conditions don't change. */
export const SMOKE_REQUEST: Request = {
    id: 'smoke',
    kind: 'A smoke run of the harness',
    prompt: 'Load the serenity-js-writing-tests skill. Then read .kiro/skills/serenity-js-screenplay/references/tasks.md with your file-reading tool, not a shell command, or .agents/skills/serenity-js-screenplay/references/tasks.md the same way, if that\'s where the skills are. Run `cat .mocharc.yml`. Run `curl` against the math.js API URL in the test script in package.json, to calculate 1 + 1. Then add a scenario to spec/math-js_api.spec.ts that checks that 1 + 1 equals 2, and run the tests.',
    needs: [ 'tests', 'tasks' ],
    apis: [ 'mathjs' ],
};

const SKILL = 'serenity-js-writing-tests';
const FILE = 'serenity-js-screenplay/references/tasks.md';
const COMMAND = 'cat .mocharc.yml';

const CREDENTIALS: Record<Agent, string[]> = {
    kiro: [ 'KIRO_API_KEY' ],
    copilot: [ 'COPILOT_GITHUB_TOKEN' ],
};
const HOMES = [ 'KIRO_HOME', 'COPILOT_HOME', 'COPILOT_AUTO_UPDATE', 'npm_config_cache' ];
// the harness sets them, so the agent reaches the local API server directly
const NO_PROXY = [ 'NO_PROXY', 'no_proxy' ];
// the harness sets them in every run, for request 9's calculation jobs
const JOB_DIRECTORIES = [ 'JOBS_DIR', 'RESULTS_DIR' ];

// a skill's name, or the path of an agent's skill directory or a package's skills
const SKILL_LEAK = /\bserenity-js-[\da-z-]+|\/skills\//;

export interface SmokeRecord {
    completedToolCalls: number;
    skillReads: SkillRead[];
    shellCommands: string[];
    /** Every model the stream names as answering */
    models: string[];
    /** At least one assistant.usage or assistant.message event: a model answered, whichever it was */
    modelAnswered: boolean;
    credits: number | undefined;
    premiumRequests: number | undefined;
    checksSandboxed: boolean;
    agentEnvironment: string[];
    /** The requests the local API server logged while the agent ran, and while the harness's tsc and npm test ran */
    serverRequests: { agent: number, checks: number };
}

export interface SmokeInput {
    agent: Agent;
    pin: string;
    /** Why scoring stopped, when it did, such as a stream the parser didn't recognise */
    error: string | undefined;
    record: SmokeRecord | undefined;
    logs: { tsc: boolean, test: boolean };
    resultSaved: boolean;
    /** The review packet's text, when there is one */
    packet: string | undefined;
}

export interface SmokeCheck {
    name: string;
    ok: boolean;
    /** Whose failure it is: the agent ignored the prompt, or the harness didn't see what happened */
    cause?: 'agent' | 'harness';
    detail?: string;
}

const ok = (name: string): SmokeCheck => ({ name, ok: true });
const failed = (name: string, cause: 'agent' | 'harness', detail: string): SmokeCheck => ({ name, ok: false, cause, detail });
const check = (name: string, cause: 'agent' | 'harness', problem: string | undefined): SmokeCheck => problem ? failed(name, cause, problem) : ok(name);

const NAMES = [ 'the stream', 'the skill load', 'the file read', 'the shell command', 'the model', 'the usage', 'the sandboxed checks', 'the results', 'the environment',
    'the agent and the local server', "the harness's npm test and the local server" ];

function environmentProblem(agent: Agent, names: string[]): string | undefined {
    const own = CREDENTIALS[agent];
    const unexpected = names.filter(name => ! own.includes(name) && ! HOMES.includes(name) && ! name.startsWith('LC_')
        && ! ENVIRONMENT_BASICS.includes(name) && ! NO_PROXY.includes(name) && ! JOB_DIRECTORIES.includes(name));
    if (unexpected.length > 0) {
        return `the agent got ${ unexpected.join(', ') }, which it shouldn't`;
    }
    return names.some(name => own.includes(name)) ? undefined : `the agent got none of its credentials: ${ own.join(' or ') }`;
}

/** The agent ran curl, as asked, and the local server logged it: a curl the server didn't log means the sandbox blocked it. */
function localServerCheck(record: SmokeRecord): SmokeCheck {
    if (! record.shellCommands.some(command => /\bcurl\b/.test(command))) {
        return failed(NAMES[9], 'agent', "the agent didn't run curl against the local server");
    }
    return check(NAMES[9], 'harness', record.serverRequests.agent > 0 ? undefined : 'the agent ran curl, but the local server logged no request from it: is it reachable from the sandbox?');
}

/** The prompt asks for a file-reading tool, so a shell read is the agent's choice, which the harness saw. */
function fileReadProblem(skillReads: SkillRead[]): string | undefined {
    const reads = skillReads.filter(skillRead => skillRead.file === FILE);
    if (reads.some(skillRead => skillRead.via === 'read')) {
        return undefined;
    }
    return reads.some(skillRead => skillRead.via === 'shell')
        ? `the agent read ${ FILE } with a shell command instead of the file-reading tool`
        : `the agent didn't read ${ FILE }`;
}

/**
 * A model has to have answered, which session.start's selectedModel doesn't show: it's only the model the harness asked
 * for, so a session that refused to start has it too. With a model for a pin, every model the stream names has to be it.
 */
function modelProblem(pin: string, record: SmokeRecord): string | undefined {
    if (! record.modelAnswered) {
        return 'no model answered: the stream has no assistant.usage or assistant.message event';
    }
    if (pin === 'auto' || (record.models.length > 0 && record.models.every(model => model === pin))) {
        return undefined;
    }
    return `the stream reports ${ record.models.join(', ') || 'no model' }, but the pin is ${ pin }`;
}

/** One check per thing the smoke run's request asks for, and per thing the harness has to do with it. */
export function smokeChecks({ agent, pin, error, record, logs, resultSaved, packet }: SmokeInput): SmokeCheck[] {
    if (error || ! record) {
        return [
            failed(NAMES[0], 'harness', `scoring stopped: ${ error ?? 'no result' }`),
            ...NAMES.slice(1).map(name => failed(name, 'harness', 'not checked, because scoring stopped')),
        ];
    }
    const read = (file: string, via: SkillRead['via']) => record.skillReads.some(skillRead => skillRead.file === file && skillRead.via === via);
    return [
        check(NAMES[0], 'harness', record.completedToolCalls > 0 ? undefined : 'the parser found no tool calls'),
        check(NAMES[1], 'agent', read(`${ SKILL }/SKILL.md`, 'skill-tool') ? undefined : `the agent didn't load the skill ${ SKILL }`),
        check(NAMES[2], 'agent', fileReadProblem(record.skillReads)),
        check(NAMES[3], 'agent', record.shellCommands.some(command => command.includes(COMMAND)) ? undefined : `the agent didn't run ${ COMMAND }`),
        check(NAMES[4], 'harness', modelProblem(pin, record)),
        check(NAMES[5], 'harness', agent === 'kiro'
            ? (record.credits === undefined ? 'no credits recorded' : undefined)
            : (record.premiumRequests === undefined ? 'no premium requests recorded' : undefined)),
        check(NAMES[6], 'harness', ! record.checksSandboxed ? "tsc and npm test didn't run under sandbox-exec"
            : (! logs.tsc ? 'no tsc.log' : (! logs.test ? 'no test.log' : undefined))),
        check(NAMES[7], 'harness', ! resultSaved ? 'no result.json'
            : (packet === undefined ? 'no review packet' : (SKILL_LEAK.test(packet) ? 'the review packet names a skill or a skill path' : undefined))),
        check(NAMES[8], 'harness', environmentProblem(agent, record.agentEnvironment)),
        localServerCheck(record),
        check(NAMES[10], 'harness', record.serverRequests.checks > 0 ? undefined : "the local server logged no request from the harness's tsc and npm test"),
    ];
}

/** One line per check, ok or failed. */
export function renderSmoke(agent: Agent, checks: SmokeCheck[]): string {
    return checks.map(each => `${ agent }: ${ each.ok ? 'ok    ' : 'failed' }  ${ each.name }${ each.ok ? '' : `: ${ each.detail }` }`).join('\n');
}

/** What failed, with the harness's failures apart from the agent's, or `undefined` when every check passed. */
export function smokeProblem(checks: SmokeCheck[]): string | undefined {
    const list = (cause: 'agent' | 'harness') => checks.filter(each => ! each.ok && each.cause === cause).map(each => `${ each.name } (${ each.detail })`);
    const harness = list('harness');
    const agent = list('agent');
    if (harness.length === 0 && agent.length === 0) {
        return undefined;
    }
    return `the smoke run failed: ${ [
        ...(harness.length > 0 ? [ `the harness: ${ harness.join(', ') }` ] : []),
        ...(agent.length > 0 ? [ `the agent didn't follow the prompt: ${ agent.join(', ') }` ] : []),
    ].join('; ') }`;
}
