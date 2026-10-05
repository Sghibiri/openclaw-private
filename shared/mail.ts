// Email and calendar providers the private mail connector can reach, and the
// hosts each one needs. Only providers listed here can be connected: every
// host is on the private gateway's egress allowlist only while connected,
// and adding a provider means adding hosts, which needs the owner's approval.

export type MailProviderId = "gmail";

export type MailProvider = {
  label: string;
  /** IMAP over TLS; the egress proxy opens port 993 to this host only. */
  imapHost: string;
  imapPort: 993;
  /** Hosts a calendar link may point at (HTTPS, port 443). */
  calendarHosts: string[];
  appPasswordHelp: string;
  calendarHelp: string;
};

export const MAIL_PROVIDERS: Record<MailProviderId, MailProvider> = {
  gmail: {
    label: "Gmail and Google Calendar",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    calendarHosts: ["calendar.google.com"],
    appPasswordHelp:
      "Create an app password at https://myaccount.google.com/apppasswords (it needs 2-Step Verification on). Name it OpenClaw Private and copy the 16 letters.",
    calendarHelp:
      "In Google Calendar on a computer: Settings, click your calendar on the left, then Integrate calendar, and copy the 'Secret address in iCal format'.",
  },
};

export function isMailProviderId(value: unknown): value is MailProviderId {
  return typeof value === "string" && Object.hasOwn(MAIL_PROVIDERS, value);
}

/** Tools the connector adds to a private gateway. All of them only read. */
export const MAIL_TOOL_NAMES = ["mail_search", "mail_read", "calendar_events"] as const;

/** Secret store ids the connector's setup writes. */
export const MAIL_SECRET_IDS = {
  password: "PRIVATE_MAIL_PASSWORD",
  calendarUrl: "PRIVATE_CALENDAR_URL",
} as const;
