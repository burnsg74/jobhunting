// Job Hunting API. node:http only, loopback bound, no auth (local machine only).
import { createServer } from "node:http";
import { ValidationError } from "./schema.js";
import { dailyReport, defaultRange } from "./reports.js";
import { createPulls } from "./pulls.js";
import { ConflictError, DataAccessError, NotFoundError, createStore } from "./store.js";
import { DEFAULT_TZ, isDateString } from "./tz.js";

const MAX_BODY = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function intParam(value, fallback, { min = 0, max = 10_000 } = {}) {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, "Invalid number parameter");
  return n;
}

function dateParam(value, label) {
  if (value === null || value === "") return undefined;
  if (!isDateString(value)) throw new HttpError(400, `${label} must be YYYY-MM-DD`);
  return value;
}

export function createApp(config, store = createStore(config.dir, { tz: config.timezone ?? DEFAULT_TZ }), pulls = createPulls({ config, store })) {
  const tz = config.timezone ?? DEFAULT_TZ;

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const method = req.method;
    let segments;
    try {
      segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
    } catch {
      throw new HttpError(400, "Malformed URL");
    }
    if (segments[0] !== "api") throw new HttpError(404, "Not found");
    const [, resource, id, action] = segments;
    const q = (name) => url.searchParams.get(name);

    if (resource === "health" && method === "GET") {
      const { jobs, events } = await store.health();
      const ok = jobs.ok && events.ok;
      return send(res, ok ? 200 : 503, {
        ok,
        env: config.mode,
        dataDir: store.dir,
        jobsReadable: jobs.ok,
        eventsReadable: events.ok,
        ...(ok ? {} : { error: jobs.error ?? events.error }),
      });
    }

    if (resource === "jobs") {
      if (!id && method === "GET") {
        const auto = q("auto_deleted");
        return send(res, 200, {
          jobs: await store.listJobs({ status: q("status") ?? undefined, q: q("q") ?? undefined, auto_deleted: auto ?? undefined }),
        });
      }
      if (id === "ids" && !action && method === "GET") return send(res, 200, { ids: await store.jobIds() });
      if (!id && method === "POST") {
        const result = await store.ingestJob(await readJson(req));
        return send(res, result.created ? 201 : 200, result);
      }
      if (id && !action && method === "GET") return send(res, 200, await store.getJob(id));
      if (id && action === "status" && method === "POST") {
        return send(res, 200, await store.setStatus(id, await readJson(req)));
      }
    }

    if (resource === "events") {
      if (!id && method === "GET") {
        const limit = intParam(q("limit"), undefined, { min: 1, max: 1000 });
        return send(
          res,
          200,
          await store.listEvents({
            from: dateParam(q("from"), "from"),
            to: dateParam(q("to"), "to"),
            job_id: q("job_id") || undefined,
            type: q("type") || undefined,
            limit,
            offset: intParam(q("offset"), 0),
            bodies: q("bodies") === "1",
          }),
        );
      }
      if (!id && method === "POST") return send(res, 201, await store.createEvent(await readJson(req)));
      if (id && method === "GET") return send(res, 200, await store.getEvent(id));
      if (id && method === "PATCH") return send(res, 200, await store.updateEvent(id, await readJson(req)));
      if (id && method === "DELETE") return send(res, 200, await store.deleteEvent(id));
    }

    if (resource === "reports" && id === "daily" && method === "GET") {
      const fallback = defaultRange(new Date(), tz);
      const from = dateParam(q("from"), "from") ?? fallback.from;
      const to = dateParam(q("to"), "to") ?? fallback.to;
      if (from > to) throw new HttpError(400, "from must not be after to");
      return send(res, 200, dailyReport(await store.allEvents(), { from, to }, tz));
    }

    if (resource === "pulls") {
      if (!id && method === "POST") return send(res, 202, { run: await pulls.start() });
      if (id === "current" && !action && method === "GET") return send(res, 200, { run: pulls.current() });
      if (id === "current" && action === "cancel" && method === "POST") return send(res, 200, { run: pulls.cancel() });
    }

    throw new HttpError(404, "Not found");
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      if (error instanceof ValidationError || error instanceof RangeError) return send(res, 400, { error: error.message });
      if (error instanceof NotFoundError) return send(res, 404, { error: error.message });
      if (error instanceof ConflictError) return send(res, 409, { error: error.message });
      if (error instanceof DataAccessError) return send(res, 503, { error: error.message });
      console.error(error);
      send(res, 500, { error: "Internal error" });
    }
  });
  server.pulls = pulls;
  return server;
}
