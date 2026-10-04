/**
 * Delete the VM that belongs to a conversation id:
 *
 *   npm run release -- <id>
 *
 * Flue never tears a sandbox down; the application does. A long-running
 * server would call `repoVms.release(id)` when a conversation is closed, and
 * `repoVms.releaseAll()` on shutdown. `release` finds the VM by its
 * `flue-id` tag, so it also works from a fresh process like this one.
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
