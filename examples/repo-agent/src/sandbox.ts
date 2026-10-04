/**
 * The Cove-backed sandbox for the repo agent.
 *
 * Built ONCE at module scope, not inside the agent function: Flue renders the
 * agent many times, and this one factory instance is what remembers which VM
 * belongs to which conversation id, so `release()` can delete it later.
 *
 * Configuration comes from the environment (see the README): COVE_API_URL plus
 * COVE_API_KEY or COVE_API_KEY_FILE.
 */
import { coveVms } from "flue-cove";

export const repoVms = coveVms({
  cpus: 2,
  memoryMb: 4096,
  // Marks this app's VMs, and keeps it from adopting another app's VM that
  // happens to share a conversation id.
  tags: { app: "repo-agent", ...extraTags() },
  // Backstop: Cove deletes the VM itself after 2 hours even if nobody calls
  // release(), e.g. when the process crashes.
  expiry: { maxLifetimeSecs: 2 * 60 * 60 },
  // Mirror command output to stderr while it runs; Flue only sees the result.
  onOutput: process.env.REPO_AGENT_ECHO ? (chunk) => process.stderr.write(chunk) : undefined,
});

/** `REPO_AGENT_TAGS="k=v,k2=v2"` adds tags, e.g. to mark test runs. */
function extraTags(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (process.env.REPO_AGENT_TAGS ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}
