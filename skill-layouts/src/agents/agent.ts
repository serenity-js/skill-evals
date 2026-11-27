// What the harness needs to know about an agent to run it, and to read what it did: one adapter per agent, in a module
// of its own, registered in index.ts.
import type { Trace } from '../streams.ts';

/**
 * The hosts the agents' sandboxes let shell commands reach: the local API server, which stands in for the template's
 * math.js API and the exchange rates API request 4 asks for. The public APIs themselves aren't reachable.
 */
export const ALLOWED_HOSTS = [ '127.0.0.1', 'localhost' ];

export interface AgentAdapter<Id extends string = string> {
    readonly id: Id;
    /** The agent's executable, on PATH: what the runs start, and what --version is asked of */
    readonly executable: string;
    /**
     * The command that runs the agent on a request, as close to the other agents' as each allows: every tool allowed,
     * shell commands in the agent's OS sandbox, the scenarios' APIs reachable from it, and the model pinned
     */
    command(model: string, prompt: string): { command: string, args: string[] };
    /** The variable that names the agent's home, such as KIRO_HOME */
    readonly homeVariable: string;
    /** Constant variables every run gets for this agent, such as COPILOT_AUTO_UPDATE=false */
    readonly environment: Readonly<Record<string, string>>;
    /** Writes the agent's settings, with its sandbox on, into its empty home */
    prepareHome(home: string): void;
    /** The variables the agent authenticates with, without the user's login */
    readonly credentials: readonly string[];
    /** The agent's credential in the user's environment, the only one its runs get */
    credentialOf(env: NodeJS.ProcessEnv): Record<string, string>;
    /** Why the agent can't authenticate, when the user's environment doesn't have its credential */
    credentialProblem(env: NodeJS.ProcessEnv): string | undefined;
    /** Anything else of the user's, in their home directory, that would reach the agent's runs */
    otherProblems(userHome: string): string[];
    /** What the agent did, from its event stream */
    parseStream(stream: string, run: { timedOut: boolean }): Trace;
    /**
     * How a user links their dependencies' skills for this agent with `npx skills`: the skills CLI's ID for the agent,
     * the project directory it links them into, and a directory the project needs before the CLI links into it at all
     */
    readonly skills: { readonly cliAgent: string, readonly directory: string, readonly needs?: string };
    /** The smoke run's check of the usage the agent reports: credits, or premium requests */
    usageProblem(record: { credits?: number, premiumRequests?: number }): string | undefined;
}
