// Read-only access to one mailbox over IMAP. Every call opens a short
// connection through the private gateway's egress proxy, opens the mailbox
// with EXAMINE (the server itself refuses any change in that state), reads,
// and logs out. Nothing here can send, move, flag or delete a message.
import { ImapFlow } from "imapflow";

export type MailQuery = {
  /** Free text; for Gmail it uses Gmail's own search syntax. */
  query?: string;
  from?: string;
  sinceDays: number;
  unreadOnly: boolean;
  limit: number;
};

export type MailSummary = {
  id: string;
  date: string;
  from: string;
  subject: string;
  unread: boolean;
};

export type MailMessage = MailSummary & { to: string; text: string; truncated: boolean };

export type MailReader = {
  search(query: MailQuery): Promise<MailSummary[]>;
  read(id: string, maxChars: number): Promise<MailMessage | undefined>;
};

type Address = { name?: string; address?: string };
type Envelope = { date?: Date; subject?: string; from?: Address[]; to?: Address[] };
type Structure = {
  part?: string;
  type: string;
  disposition?: string;
  childNodes?: Structure[];
};
type FetchedMessage = {
  uid: number;
  envelope?: Envelope;
  flags?: Set<string>;
  bodyStructure?: Structure;
};

/** The slice of ImapFlow used here; tests pass a fake. */
export type ImapClient = {
  connect(): Promise<void>;
  mailboxOpen(path: string, options: { readOnly: boolean }): Promise<unknown>;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false>;
  fetch(
    range: number[],
    query: Record<string, boolean>,
    options: { uid: true },
  ): AsyncIterable<FetchedMessage>;
  fetchOne(
    range: string,
    query: Record<string, boolean>,
    options: { uid: true },
  ): Promise<FetchedMessage | false>;
  download(
    range: string,
    part: string,
    options: { uid: true; maxBytes: number },
  ): Promise<{ content: AsyncIterable<Buffer | string> }>;
  logout(): Promise<void>;
  close(): void;
};

export type MailConnection = {
  host: string;
  port: number;
  user: string;
  password: string;
  /** The privacy egress proxy (always on the private gateway; absent only for the owner's login test). */
  proxyUrl?: string;
  /** Gmail understands its own search syntax (X-GM-RAW). */
  gmail: boolean;
};

const MAX_DOWNLOAD_BYTES = 512 * 1024;

export function createImapClient(connection: MailConnection): ImapClient {
  return new ImapFlow({
    host: connection.host,
    port: connection.port,
    secure: true,
    auth: { user: connection.user, pass: connection.password },
    ...(connection.proxyUrl ? { proxy: connection.proxyUrl } : {}),
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 30_000,
    socketTimeout: 60_000,
  }) as unknown as ImapClient;
}

function formatAddress(list: Address[] | undefined): string {
  return (list ?? [])
    .map((entry) =>
      entry.name && entry.address
        ? `${entry.name} <${entry.address}>`
        : (entry.address ?? entry.name ?? ""),
    )
    .filter(Boolean)
    .join(", ");
}

function summarize(message: FetchedMessage): MailSummary {
  return {
    id: String(message.uid),
    date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : "",
    from: formatAddress(message.envelope?.from),
    subject: message.envelope?.subject ?? "(no subject)",
    unread: !(message.flags?.has("\\Seen") ?? false),
  };
}

/**
 * The first inline text part, preferring plain text over HTML. Attachments,
 * attached emails included, are never descended into or read.
 */
export function pickTextPart(structure: Structure | undefined): Structure | undefined {
  if (!structure) {
    return undefined;
  }
  const parts: Structure[] = [];
  const walk = (node: Structure) => {
    if (node.disposition === "attachment" || node.type === "message/rfc822") {
      return;
    }
    if (node.childNodes?.length) {
      node.childNodes.forEach(walk);
    } else {
      parts.push(node);
    }
  };
  walk(structure);
  return (
    parts.find((node) => node.type === "text/plain") ??
    parts.find((node) => node.type === "text/html")
  );
}

const MAX_HTML_CHARS = 256 * 1024;
const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Readable text from an HTML body: no tags, scripts, styles or comments.
 * One forward pass, so a crafted email cannot make it slow; an unclosed
 * tag or comment ends the text there.
 */
export function htmlToText(input: string): string {
  const html = input.length > MAX_HTML_CHARS ? input.slice(0, MAX_HTML_CHARS) : input;
  const lower = html.toLowerCase();
  let out = "";
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, open);
    if (lower.startsWith("<!--", open)) {
      const close = lower.indexOf("-->", open + 4);
      if (close === -1) {
        break;
      }
      out += " ";
      at = close + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) {
      break;
    }
    const tag = lower.slice(open + 1, close);
    const ending = tag.startsWith("/");
    const name = /^\/?\s*([a-z0-9]+)/u.exec(tag)?.[1] ?? "";
    if (!ending && (name === "script" || name === "style" || name === "head")) {
      const end = lower.indexOf(`</${name}`, close + 1);
      if (end === -1) {
        break;
      }
      const endClose = html.indexOf(">", end);
      out += " ";
      at = endClose === -1 ? html.length : endClose + 1;
      continue;
    }
    out += name === "br" || (ending && BLOCK_TAGS.has(name)) ? "\n" : " ";
    at = close + 1;
  }
  const decoded = out.replace(
    /&(?:nbsp|amp|lt|gt|quot|apos|#39);/giu,
    (entity) => ENTITIES[entity.toLowerCase()] ?? entity,
  );
  const lines: string[] = [];
  for (const line of decoded.split("\n")) {
    const text = line.replace(/[ \t\r\f\v]+/gu, " ").trim();
    if (text || (lines.length > 0 && lines.at(-1) !== "")) {
      lines.push(text);
    }
  }
  return lines.join("\n").trim();
}

async function readStream(content: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of content) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buffer);
    size += buffer.length;
    if (size >= MAX_DOWNLOAD_BYTES) {
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, MAX_DOWNLOAD_BYTES).toString("utf8");
}

export function createMailReader(
  connection: MailConnection,
  makeClient: (connection: MailConnection) => ImapClient = createImapClient,
): MailReader {
  const withInbox = async <T>(work: (client: ImapClient) => Promise<T>): Promise<T> => {
    const client = makeClient(connection);
    await client.connect();
    try {
      // EXAMINE: the server keeps the mailbox read-only for this session.
      await client.mailboxOpen("INBOX", { readOnly: true });
      return await work(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  };
  return {
    search: (query) =>
      withInbox(async (client) => {
        const since = new Date(Date.now() - query.sinceDays * 24 * 60 * 60 * 1000);
        const criteria: Record<string, unknown> = { since };
        if (query.unreadOnly) {
          criteria.seen = false;
        }
        if (query.from) {
          criteria.from = query.from;
        }
        if (query.query) {
          if (connection.gmail) {
            criteria.gmraw = query.query;
          } else {
            criteria.text = query.query;
          }
        }
        const uids = (await client.search(criteria, { uid: true })) || [];
        const newest = uids.toSorted((a, b) => b - a).slice(0, query.limit);
        if (newest.length === 0) {
          return [];
        }
        const found: MailSummary[] = [];
        for await (const message of client.fetch(
          newest,
          { uid: true, envelope: true, flags: true },
          { uid: true },
        )) {
          found.push(summarize(message));
        }
        return found.toSorted((a, b) => b.date.localeCompare(a.date));
      }),
    read: (id, maxChars) =>
      withInbox(async (client) => {
        if (!/^\d{1,10}$/u.test(id)) {
          return undefined;
        }
        const message = await client.fetchOne(
          id,
          { uid: true, envelope: true, flags: true, bodyStructure: true },
          { uid: true },
        );
        if (!message) {
          return undefined;
        }
        const part = pickTextPart(message.bodyStructure);
        let text = "";
        if (part) {
          // A single-part message has no part number; its body is part "1".
          const { content } = await client.download(id, part.part ?? "1", {
            uid: true,
            maxBytes: MAX_DOWNLOAD_BYTES,
          });
          const raw = await readStream(content);
          text = part.type === "text/html" ? htmlToText(raw) : raw.trim();
        }
        const truncated = text.length > maxChars;
        return {
          ...summarize(message),
          to: formatAddress(message.envelope?.to),
          text: truncated ? text.slice(0, maxChars) : text,
          truncated,
        };
      }),
  };
}
