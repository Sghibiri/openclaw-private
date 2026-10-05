// Read-only calendar: the provider's private calendar link (an iCalendar
// feed) is fetched through the egress proxy and its events are listed for a
// time window, with repeating events expanded. The link works like a
// password, so it lives in the secret store and is never shown or logged.
//
// A calendar can hold entries written by others (invitations land in it
// automatically), and some repeat rules make the iCalendar library loop
// forever inside one step. So expansion runs in a worker thread that is
// stopped after a few seconds, and the gateway never waits on it longer.
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type ICAL from "ical.js";

export type CalendarEvent = {
  start: string;
  end: string;
  allDay: boolean;
  title: string;
  location: string;
};

const MAX_FEED_BYTES = 8 * 1024 * 1024;
const EXPAND_TIMEOUT_MS = 10_000;
const EXPAND_BUDGET_MS = 5_000;

/** True when the link is HTTPS on one of the provider's calendar hosts. */
export function isAllowedCalendarUrl(url: string, hosts: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      (parsed.port === "" || parsed.port === "443") &&
      hosts.includes(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new Error("the calendar feed is too large to read");
  }
  if (!response.body) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("the calendar feed is too large to read");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchCalendarFeed(
  url: string,
  hosts: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!isAllowedCalendarUrl(url, hosts)) {
    throw new Error(`the calendar link must be an https link on ${hosts.join(" or ")}`);
  }
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "text/calendar" },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404 || response.status === 403
        ? "the calendar link no longer works (it may have been reset); run: openclaw privacy mail connect"
        : `the calendar service answered HTTP ${response.status}`,
    );
  }
  return await readCapped(response, MAX_FEED_BYTES);
}

/**
 * Events overlapping [fromMs, toMs), repeats expanded, sorted by start.
 * Runs inside the worker: it must use only its parameters and built-ins,
 * because its source text is what the worker executes.
 */
export function expandCalendarFeed(
  ical: typeof ICAL,
  feed: string,
  fromMs: number,
  toMs: number,
  budgetMs: number,
): CalendarEvent[] {
  const maxInWindow = 500;
  const deadline = Date.now() + budgetMs;
  const root = new ical.Component(ical.parse(feed));
  for (const zone of root.getAllSubcomponents("vtimezone")) {
    ical.TimezoneService.register(zone);
  }
  const vevents = root.getAllSubcomponents("vevent");
  // Moved or cancelled single occurrences carry the series UID plus RECURRENCE-ID.
  const exceptions = new Map<string, ICAL.Component[]>();
  for (const vevent of vevents) {
    if (vevent.hasProperty("recurrence-id")) {
      const uid = String(vevent.getFirstPropertyValue("uid") ?? "");
      exceptions.set(uid, [...(exceptions.get(uid) ?? []), vevent]);
    }
  }
  const events: CalendarEvent[] = [];
  const add = (start: ICAL.Time, end: ICAL.Time, item: ICAL.Event): boolean => {
    const startMs = start.toJSDate().getTime();
    const endMs = Math.max(end.toJSDate().getTime(), startMs);
    if (endMs <= fromMs || startMs >= toMs) {
      return false;
    }
    const status = String(item.component.getFirstPropertyValue("status") ?? "");
    if (status.toUpperCase() !== "CANCELLED") {
      events.push({
        start: start.isDate ? start.toString() : new Date(startMs).toISOString(),
        end: end.isDate ? end.toString() : new Date(endMs).toISOString(),
        allDay: start.isDate,
        title: item.summary || "(no title)",
        location: item.location || "",
      });
    }
    return true;
  };
  for (const vevent of vevents) {
    if (Date.now() > deadline) {
      break;
    }
    if (vevent.hasProperty("recurrence-id")) {
      continue;
    }
    const event = new ical.Event(vevent);
    if (!event.startDate) {
      continue;
    }
    if (!event.isRecurring()) {
      add(event.startDate, event.endDate ?? event.startDate, event);
      continue;
    }
    for (const exception of exceptions.get(event.uid) ?? []) {
      event.relateException(exception);
    }
    const iterator = event.iterator();
    // Occurrences before the window are skipped, not counted: a daily meeting
    // that began years ago still shows today. Time, not count, bounds the walk.
    let inWindow = 0;
    while (inWindow < maxInWindow && Date.now() <= deadline) {
      const next = iterator.next();
      if (!next || next.toJSDate().getTime() >= toMs) {
        break;
      }
      const details = event.getOccurrenceDetails(next);
      if (add(details.startDate, details.endDate, details.item)) {
        inWindow += 1;
      }
    }
  }
  return events.toSorted((a, b) => a.start.localeCompare(b.start)).slice(0, maxInWindow);
}

const icalPath = createRequire(import.meta.url).resolve("ical.js");

/** Expands the feed in a worker thread that is stopped if it runs too long. */
export function listCalendarEvents(
  feed: string,
  from: Date,
  to: Date,
  timeoutMs = EXPAND_TIMEOUT_MS,
): Promise<CalendarEvent[]> {
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    const expand = (${expandCalendarFeed.toString()});
    try {
      const ical = require(workerData.icalPath);
      parentPort.postMessage({ ok: true, events: expand(ical, workerData.feed, workerData.from, workerData.to, workerData.budget) });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
    }`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        icalPath,
        feed,
        from: from.getTime(),
        to: to.getTime(),
        budget: EXPAND_BUDGET_MS,
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(
        new Error("the calendar has an entry that cannot be read in time; try a shorter period"),
      );
    }, timeoutMs);
    worker.once("message", (message: { ok: boolean; events?: CalendarEvent[]; error?: string }) => {
      clearTimeout(timer);
      void worker.terminate();
      if (message.ok) {
        resolve(message.events ?? []);
      } else {
        reject(new Error(`the calendar could not be read: ${message.error ?? "unknown error"}`));
      }
    });
    worker.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(new Error(`the calendar could not be read: ${error.message}`));
    });
  });
}
