/**
 * Delete the VM that belongs to a conversation id:
 *
 *   npm run release -- <id>
 *
 * Flue never tears a sandbox down; the application does. A long-running
 * server would call `repoVms.release(id)` when a conversation is closed, and
 * `repoVms.releaseAll()` on shutdown. `release` finds the VM by its
 * `flue-id` tag, so it also works from a fresh process like this one.
 *
 * Like `flue run`, `npm run release` loads `.env` (COVE_API_URL, the key,
 * REPO_AGENT_TAGS). The lookup matches every tag the factory is configured
 * with, so run it with the same REPO_AGENT_TAGS the agent ran with (or fewer):
 * an extra tag here would match nothing and delete nothing.
 */
import { repoVms } from "./sandbox.ts";

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: npm run release -- <conversation-id> [...]");
  process.exit(2);
}
for (const id of ids) {
  await repoVms.release(id);
  console.error(`released ${id}`);
}
