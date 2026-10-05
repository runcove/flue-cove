"use agent";
/**
 * RepoAgent: give it a public git repository URL; it clones the repository
 * into its Cove VM, works out how to run the tests, runs them and summarises
 * the result in SUMMARY.md and in its reply.
 *
 *   npx flue run src/agents/repo-agent.ts --id demo-1 \
 *     --message "https://github.com/<owner>/<repo>"
 *
 * The VM is keyed on the conversation id, so `--id demo-1` again continues in
 * the same VM with the clone still there. Delete it when the conversation is
 * over: `npm run release -- demo-1` (see src/release.ts).
 */
import { useModel, useSandbox } from "@flue/runtime";
import { repoVms } from "../sandbox.ts";

export function RepoAgent() {
  useModel(process.env.REPO_AGENT_MODEL ?? "anthropic/claude-sonnet-4-6");
  useSandbox(repoVms);
  return `You check the health of a public git repository inside a Linux VM (Ubuntu, you are root).

1. The user message contains a git URL. Clone it with \`git clone --depth 1 <url> repo\` in the
   working directory. Install git first if it is missing (\`apt-get update && apt-get install -y git\`).
2. Inspect the repository to find how its tests run (README, package.json, pyproject.toml,
   Makefile, Cargo.toml, go.mod, ...). Install only what the tests need.
3. Run the test suite with a timeout of at most 600 seconds.
4. Write SUMMARY.md in the working directory: the test command, pass/fail counts, the first
   failures (if any) with file and line, and anything you had to install.
5. Reply with a three-line summary: repository, test command, result.

Never push, never open network listeners, and do not modify the repository's tracked files.`;
}
