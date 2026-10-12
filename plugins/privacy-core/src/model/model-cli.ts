// `openclaw privacy model` and `openclaw privacy model set <id>`, run on the
// main gateway (or with --profile private): list the enclave models the private
// Inbox agent can use, and switch it to one.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { privateGatewayDeps } from "../mail/mail-cli.js";
import { formatModelList, listEnclaveModels, setEnclaveModel, type ModelCliDeps } from "./model.js";

type CliProgram = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];
type PrivacyCommand = ReturnType<CliProgram["command"]>;

const LIST_TIMEOUT_MS = 30_000;
const MAX_LIST_BYTES = 1024 * 1024;

function modelDeps(): ModelCliDeps {
  return {
    ...privateGatewayDeps(),
    fetchJson: async (url, signal) => {
      const response = await fetch(url, { signal, redirect: "error" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      if (text.length > MAX_LIST_BYTES) {
        throw new Error("the model list is too large");
      }
      return JSON.parse(text) as unknown;
    },
  };
}

function fail(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export function registerModelCli(privacy: PrivacyCommand): void {
  const model = privacy
    .command("model")
    .description("Show or change the enclave model the private Inbox agent uses")
    .action(async () => {
      try {
        const list = await listEnclaveModels(modelDeps(), AbortSignal.timeout(LIST_TIMEOUT_MS));
        console.log(formatModelList(list).join("\n"));
      } catch (error) {
        fail(error);
      }
    });
  model
    .command("set")
    .argument("<id>", "model id from: openclaw privacy model")
    .description("Switch the private Inbox agent to another enclave model, then restart it")
    .action(async (id: string) => {
      try {
        const outcome = await setEnclaveModel(
          id,
          modelDeps(),
          AbortSignal.timeout(LIST_TIMEOUT_MS),
        );
        if (!outcome.changed) {
          return;
        }
        if (outcome.warnings.length > 0) {
          console.log("\nFinished, with things to do:");
          for (const warning of outcome.warnings) {
            console.log(`  - ${warning}`);
          }
          return;
        }
        console.log(`\nDone. The Inbox agent now reads your email with ${outcome.ref}.`);
      } catch (error) {
        fail(error);
      }
    });
}
