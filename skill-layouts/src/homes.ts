// Each run gets every agent's home and a HOME of its own, created empty, so the user's configuration, agents, MCP
// servers, steering, skills and dotfiles, such as ~/.npmrc and gh's login, don't reach the runs. npm's cache is the
// one thing the runs share, in <work>. Without the user's login, each agent authenticates from the environment, with
// the credential its adapter, in agents/, names. This module keeps the names the rest of the harness used before the
// adapters; what each agent needs is in its own module.
import { type Agent, credentialProblems as credentialProblemsOf, otherProblems } from './agents/index.ts';

export { ALLOWED_HOSTS } from './agents/agent.ts';
export { COPILOT_ALLOWED_HOSTS } from './agents/copilot.ts';
export { type AgentHomes, prepareAgentHomes } from './agents/index.ts';

/** What's missing for the agents to authenticate with empty homes. */
export function credentialProblems(agents: readonly Agent[], env: NodeJS.ProcessEnv): string[] {
    return credentialProblemsOf(agents, env);
}

/** Skills of the user's that would reach Copilot's runs, whatever COPILOT_HOME says. */
export function personalSkillsProblems(agents: readonly Agent[], home: string): string[] {
    return otherProblems(agents, home);
}
