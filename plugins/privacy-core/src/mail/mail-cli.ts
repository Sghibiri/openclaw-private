// `openclaw privacy mail connect | disconnect | status`, run on the main
// gateway: connects one mailbox (and optionally its calendar) to the private
// Inbox agent. The password and calendar link go straight into the private
// gateway's secret store; the main gateway never keeps them.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveRequiredHomeDir } from "openclaw/plugin-sdk/state-paths";
import { MAIL_PROVIDERS } from "../../../../shared/mail.js";
import { ask, askHidden, runProcess } from "../setup/cli.js";
import { PRIVATE_PROFILE } from "../setup/plan.js";
import { privateProfileEnv } from "../setup/run.js";
import { fetchCalendarFeed, isAllowedCalendarUrl, listCalendarEvents } from "./calendar.js";
import {
  connectMail,
  describeMailConnection,
  disconnectMail,
  type MailCliDeps,
} from "./connect.js";
import { createImapClient } from "./imap.js";

type CliProgram = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];
type PrivacyCommand = ReturnType<CliProgram["command"]>;

function mailDeps(): MailCliDeps {
  const privateConfigPath = path.join(
    resolveRequiredHomeDir(),
    `.openclaw-${PRIVATE_PROFILE}`,
    "openclaw.json",
  );
  const env = privateProfileEnv({ ...process.env });
  return {
    openclawPrivate: (args, input) =>
      runProcess(
        process.execPath,
        [...(process.argv[1] ? [process.argv[1]] : []), "--profile", PRIVATE_PROFILE, ...args],
        { ...(input !== undefined ? { input } : {}), env },
      ),
    privateConfigPath,
    readFile: async (file) => readFile(file, "utf8").catch(() => undefined),
    writeFileAtomic: async (file, content) => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      await writeFile(temp, content, { mode: 0o600, flag: "wx" });
      await rename(temp, file);
    },
    log: (line) => console.log(line),
  };
}

/** Logs in once and opens the inbox read-only: proves the password without reading anything. */
async function testLogin(host: string, port: number, user: string, password: string) {
  const client = createImapClient({ host, port, user, password, gmail: true });
  await client.connect();
  try {
    const box = (await client.mailboxOpen("INBOX", { readOnly: true })) as { exists?: number };
    return box.exists ?? 0;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function finish(warnings: string[], done: string): void {
  if (warnings.length > 0) {
    console.log("\nFinished, with things to do:");
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
    return;
  }
  console.log(`\n${done}`);
}

async function runConnect(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log("Run openclaw privacy mail connect in a terminal: it asks for the password.");
    return false;
  }
  const provider = MAIL_PROVIDERS.gmail;
  console.log(`Connect your email to the private Inbox agent (${provider.label}), read-only.`);
  console.log(
    "Only the private gateway reads it, with the enclave model. Your main assistant gets short answers, never the emails.\n",
  );
  const address = (await ask("Your Gmail address: ")).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) {
    console.log("That is not an email address; nothing was changed.");
    return false;
  }
  console.log(`\n${provider.appPasswordHelp}`);
  console.log("Paste it once and press Enter; each character shows as *.");
  const password = (await askHidden("App password: ")).replace(/\s+/gu, "");
  if (!password) {
    console.log("No password given; nothing was changed.");
    return false;
  }
  console.log(`Password received (${password.length} characters).`);
  process.stdout.write("  ..  testing the login (opens the inbox read-only, reads nothing)\n");
  try {
    const count = await testLogin(provider.imapHost, provider.imapPort, address, password);
    console.log(`  ok  login works: ${count} emails in the inbox`);
  } catch (error) {
    console.log(
      `  xx  ${provider.imapHost} refused the login: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(
      "Check the address, and that you pasted an app password (not your normal password). Nothing was changed.",
    );
    return false;
  }
  console.log(`\nCalendar (optional). ${provider.calendarHelp}`);
  console.log("It works like a password, so it is hidden too. Press Enter to skip.");
  const calendarUrl = (await askHidden("Calendar link: ")).trim();
  if (calendarUrl) {
    if (!isAllowedCalendarUrl(calendarUrl, provider.calendarHosts)) {
      console.log(
        `That is not a private calendar link on ${provider.calendarHosts.join(", ")}; nothing was changed.`,
      );
      return false;
    }
    try {
      const now = new Date();
      const events = await listCalendarEvents(
        await fetchCalendarFeed(calendarUrl, provider.calendarHosts),
        now,
        new Date(now.getTime() + 7 * 86_400_000),
      );
      console.log(`  ok  calendar works: ${events.length} events in the next 7 days`);
    } catch (error) {
      console.log(
        `  xx  the calendar link did not work: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`,
      );
      return false;
    }
  }
  console.log("");
  const { warnings } = await connectMail(
    { provider: "gmail", address, password, ...(calendarUrl ? { calendarUrl } : {}) },
    mailDeps(),
  );
  finish(
    warnings,
    'Done. Ask your assistant: "Ask the inbox agent what is important in my email today."',
  );
  return true;
}

export function registerMailCli(privacy: PrivacyCommand): void {
  const mail = privacy
    .command("mail")
    .description("Connect your email and calendar to the private Inbox agent (read-only)");
  mail
    .command("connect")
    .description("Connect a Gmail address with an app password, and optionally its calendar")
    .action(async () => {
      const ok = await runConnect().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        return false;
      });
      if (!ok) {
        process.exitCode = 1;
      }
    });
  mail
    .command("disconnect")
    .description("Remove the connector and delete the stored password and calendar link")
    .action(async () => {
      try {
        const { warnings } = await disconnectMail(mailDeps());
        finish(warnings, "Done. The private gateway no longer reads your email.");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
  mail
    .command("status")
    .description("Show which mailbox is connected")
    .action(async () => {
      const deps = mailDeps();
      console.log(describeMailConnection(await deps.readFile(deps.privateConfigPath)));
    });
}
