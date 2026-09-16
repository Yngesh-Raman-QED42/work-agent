import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';

const ConfigSchema = z.object({
  jira: z.object({
    // Reserved for future disambiguation (e.g. "which Jira projects count as
    // mine" if you're ever a watcher/stakeholder on someone else's project).
    // NOT used to filter what gets collected — the observation layer
    // deliberately pulls every open ticket assigned to you, in every
    // project, with no allowlist. That's the whole point: it has to work
    // the day you start on a project this config has never heard of.
    myProjects: z.array(z.string()).default([]),
  }),
  github: z.object({
    // Repos where the Engineering Execution agent (Phase 2+) is allowed to
    // act autonomously at all. A resolved repo that isn't in this list is
    // treated the same as an unmapped one: stop, file to the approval
    // queue, ask. Empty on purpose — you opt a repo in explicitly, nothing
    // is ever inferred from "I saw a ticket that looked like it belonged
    // here."
    approvedRepos: z.array(z.string()).default([]),
    // Jira project key -> "owner/repo". How the execution layer finds the
    // right repo for a ticket. This is expected to grow over time as you
    // pick up new projects — it is NOT an assumption baked into the system
    // about what you work on, just the explicit mapping you've told it
    // about so far. An unmapped project key means "ambiguous, can't find
    // the repo" and stops for your input, it never guesses.
    repoMap: z.record(z.string(), z.string()).default({}),
    // "owner/repo" -> local filesystem path of an existing clone. Which
    // directory holds which repo is a per-machine fact, not something to
    // infer/search for — you tell it once here.
    repoLocalPaths: z.record(z.string(), z.string()).default({}),
    // Default branch per "owner/repo", if not "main".
    repoDefaultBranches: z.record(z.string(), z.string()).default({}),
    // "owner/repo" -> how to boot that app locally, for the optional
    // screenshot step in Engineering Execution. Screenshot capture is
    // opt-OUT, not opt-in: any approved/mapped repo gets a best-effort
    // auto-detected recipe (its own package.json "dev" script, default
    // port) unless it has an explicit entry here. An entry of `false`
    // disables it for that one repo; a real object overrides the
    // auto-detected command/port/env — e.g. when the app needs a specific
    // port, or a documented test-login step to reach an authenticated page.
    previewRecipes: z
      .record(
        z.string(),
        z.union([
          z.literal(false),
          z.object({
            startCommand: z.array(z.string()).min(1), // e.g. ["npm", "run", "dev"]
            port: z.number().int().positive(),
            readyPath: z.string().default('/'), // polled until it responds, to know the server is up
            readyTimeoutMs: z.number().int().positive().default(60_000),
            env: z.record(z.string(), z.string()).default({}), // extra env for the dev server only — never secrets checked into the repo
            // Only needed when the app requires sign-in to reach a
            // meaningful screenshot. Given to the implementer as an exact
            // recipe (see prompt.ts) rather than left for it to guess at
            // selectors on an app it can't actually see yet.
            testLogin: z
              .object({
                emailSelector: z.string(),
                email: z.string(),
                submitSelector: z.string(),
              })
              .optional(),
          }),
        ]),
      )
      .default({}),
  }),
  slack: z.object({
    relevantChannels: z.array(z.string()).default([]), // empty = not yet configured, treat all as candidate signal
  }),
  communication: z.object({
    // Off by default, always. A "consequential" draft (commitment, deadline,
    // decision, client, conflict, sensitive info) is NEVER auto-sent
    // regardless of this flag — see communication/runbook.ts. This only
    // controls whether a *routine* draft can skip the approval queue.
    autoSendRoutine: z.boolean().default(false),
  }),
});

export type WorkAgentConfig = z.infer<typeof ConfigSchema>;

// Deliberately empty — see field comments above. Populate
// work-agent.config.json as you take on projects; nothing here should ever
// need a specific project/repo name hardcoded into the app itself.
const DEFAULT_CONFIG: WorkAgentConfig = {
  jira: { myProjects: [] },
  github: { approvedRepos: [], repoMap: {}, repoLocalPaths: {}, repoDefaultBranches: {}, previewRecipes: {} },
  slack: { relevantChannels: [] },
  communication: { autoSendRoutine: false },
};

export function loadConfig(path = 'work-agent.config.json'): WorkAgentConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return ConfigSchema.parse({ ...DEFAULT_CONFIG, ...raw });
}
