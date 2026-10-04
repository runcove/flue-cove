/**
 * Model-free smoke test for the repo agent.
 *
 * Runs the real `RepoAgent` through Flue's real runtime (`start` → `init` →
 * `dispatch`), with the real `coveVms` sandbox on a real Cove VM. Only the
 * model is replaced: Pi's faux provider, registered under the `anthropic`
 * provider id the agent asks for, replays a scripted session of tool calls
 * (bash, write, read) and builds its final reply from the tool results it got
 * back. So every sandbox call the model "makes" really runs in the VM.
 *
 *   COVE_API_URL=... COVE_API_KEY_FILE=... npm run smoke
 *
 * What this does NOT exercise: a real model choosing those tool calls.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { init } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { RepoAgent } from "./src/agents/repo-agent.ts";
import { repoVms } from "./src/sandbox.ts";

const REPO = process.env.SMOKE_REPO ?? "https://github.com/simplejson/simplejson";
const TEST_CMD =
  process.env.SMOKE_TEST_CMD ?? "python3 -m unittest discover -t . -s simplejson/tests";

/** Text of the most recent tool result in the transcript. */
const lastToolText: (ctx: Parameters<FauxResponseFactory>[0]) => string = (ctx) => {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i] as { role?: string; content?: unknown };
    if (m.role === "toolResult" && Array.isArray(m.content)) {
      return m.content
        .map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
        .join("");
    }
  }
  return "";
};

let testOutput = "";
const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-sonnet-4-6" }] });
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall("bash", {
        command: `command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git); git clone --depth 1 ${REPO} repo && ls repo`,
        timeout: 300,
      }),
    ],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage(
    [fauxToolCall("bash", { command: `cd repo && ${TEST_CMD} 2>&1 | tail -n 15`, timeout: 600 })],
    { stopReason: "toolUse" },
  ),
  (ctx) => {
    testOutput = lastToolText(ctx);
    const verdict = /\bOK\b/.test(testOutput) ? "passed" : "did not pass";
    return fauxAssistantMessage(
      [
        fauxToolCall("write", {
          path: "SUMMARY.md",
          content: `# ${REPO}\n\nTest command: \`${TEST_CMD}\`\n\nResult: ${verdict}\n\n\`\`\`\n${testOutput}\n\`\`\`\n`,
        }),
      ],
      { stopReason: "toolUse" },
    );
  },
  fauxAssistantMessage([fauxToolCall("read", { path: "SUMMARY.md" })], { stopReason: "toolUse" }),
  (ctx) => {
    const summary = lastToolText(ctx);
    const result = summary.match(/Result: (.*)/)?.[1] ?? "unknown";
    const ran = testOutput.match(/Ran (\d+) tests?/)?.[1] ?? "?";
    return fauxAssistantMessage([fauxText(`${REPO}\n${TEST_CMD}\n${result} (${ran} tests)`)], {
      stopReason: "stop",
    });
  },
]);

const id = `smoke-${randomUUID()}`;
const runtime = await start({ agents: [RepoAgent], providers: [faux.provider] });
const agent = init(RepoAgent, { id });
try {
  const started = Date.now();
  const receipt = await agent.dispatch(`Please check ${REPO}`);
  const reply = await agent.read(receipt);
  console.log(
    `--- agent reply (${Math.round((Date.now() - started) / 1000)} s, VM ${repoVms.vmName(id)}) ---`,
  );
  console.log(reply.text);

  // Check the side effects in the VM directly, through the same factory:
  // the same id resolves to the same VM.
  const sandbox = await repoVms.createSandbox({ id });
  assert.equal(await sandbox.exists("repo/.git"), true, "the clone is in the VM");
  const summary = await sandbox.readFile("SUMMARY.md");
  assert.match(summary, /Test command:/);
  assert.match(reply.text ?? "", /passed|did not pass/);
  assert.equal(faux.getPendingResponseCount(), 0, "the scripted session ran to the end");
  console.log("--- SUMMARY.md in the VM ---");
  console.log(summary);
  console.log("smoke: OK");
} finally {
  await runtime.stop();
  // The application owns cleanup: delete the conversation's VM.
  await repoVms.release(id);
  console.log(`released ${id}`);
}
