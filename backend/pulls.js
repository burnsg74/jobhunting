// Runs the Wellfound capture script as a child process, one run at a time. The script prints one
// JSON line per step on stdout (`listing`, `skip`, `saved`, `failed`, `done`); anything else is a log line.
// The UI polls `current()`. When a run ends we write a `pull` event with the counts.
import { spawn } from "node:child_process";
import path from "node:path";
import { ConflictError } from "./store.js";

const LOG_LINES = 12;
const KILL_AFTER_MS = 20_000;

export function defaultCommand(config) {
  const cwd = path.join(config.repoRoot, "capture");
  return {
    cmd: process.execPath,
    args: ["--import", "tsx", "scripts/wellfound-capture.ts"],
    cwd,
  };
}

function summarize(run) {
  const counts = `${run.new} new, ${run.known} known, ${run.failed} failed`;
  if (run.status === "cancelled") return `Pull cancelled: ${counts}`;
  if (run.status === "failed") return `Pull failed: ${counts}${run.error ? ` (${run.error})` : ""}`;
  return `Pull: ${counts}`;
}

export function createPulls({ config, store, command = defaultCommand(config), spawnFn = spawn }) {
  let run = null;
  let child = null;
  let exited = Promise.resolve();

  const snapshot = () => (run ? { ...run, log: [...run.log] } : null);

  function pushLog(line) {
    run.log.push(line);
    if (run.log.length > LOG_LINES) run.log.shift();
  }

  function handleLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg = null;
    if (text.startsWith("{")) {
      try {
        msg = JSON.parse(text);
      } catch {
        msg = null;
      }
    }
    if (!msg || typeof msg !== "object" || typeof msg.event !== "string") return pushLog(text);

    switch (msg.event) {
      case "listing":
        run.total = Number(msg.total) || 0;
        pushLog(`Found ${run.total} jobs on the page`);
        break;
      case "skip":
        run.known++;
        run.index = Number(msg.index) || run.index;
        break;
      case "saved":
        run.new++;
        run.index = Number(msg.index) || run.index;
        pushLog(`Saved ${msg.name ?? msg.id}${msg.fit ? ` (${msg.fit})` : ""}`);
        break;
      case "failed":
        run.failed++;
        run.index = Number(msg.index) || run.index;
        pushLog(`Failed ${msg.id ?? ""}: ${msg.error ?? "unknown error"}`);
        break;
      case "done":
        run.done = true;
        break;
      case "log":
        pushLog(String(msg.message ?? ""));
        break;
      default:
    }
  }

  function lineReader(stream) {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    stream.on("end", () => handleLine(buffer));
  }

  async function finish(code, signal, spawnError) {
    const mine = run;
    if (mine.status === "running") {
      if (mine.cancelRequested) mine.status = "cancelled";
      else if (spawnError || code !== 0) {
        mine.status = "failed";
        mine.error = spawnError?.message ?? (signal ? `killed by ${signal}` : `exit code ${code}`);
      } else mine.status = "done";
    }
    mine.finished_at = new Date().toISOString();
    child = null;
    try {
      await store.addPull({ at: mine.finished_at, summary: summarize(mine) });
    } catch (error) {
      console.error("Could not write pull event", error);
    }
  }

  return {
    current: snapshot,

    /** Start a run. Throws ConflictError when one is already going. */
    async start() {
      if (run?.status === "running") throw new ConflictError("A pull is already running");
      run = {
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
        total: 0,
        index: 0,
        new: 0,
        known: 0,
        failed: 0,
        log: [],
        error: "",
        cancelRequested: false,
        done: false,
      };
      const env = {
        ...process.env,
        WELLFOUND_API_URL: config.apiUrl,
        ...(config.promptFile ? { WELLFOUND_PROMPT_FILE: config.promptFile } : {}),
      };
      let resolveExit;
      exited = new Promise((resolve) => (resolveExit = resolve));
      try {
        child = spawnFn(command.cmd, command.args, { cwd: command.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        await finish(null, null, error);
        resolveExit();
        return snapshot();
      }
      lineReader(child.stdout);
      lineReader(child.stderr);
      let settled = false;
      const end = (code, signal, error) => {
        if (settled) return;
        settled = true;
        finish(code, signal, error).finally(resolveExit);
      };
      child.on("error", (error) => end(null, null, error));
      child.on("close", (code, signal) => end(code, signal));
      return snapshot();
    },

    /** SIGTERM the script; its `finally` kills Chrome-Remote. Escalates to SIGKILL if it hangs. */
    cancel() {
      if (!run || run.status !== "running" || !child) return snapshot();
      run.cancelRequested = true;
      pushLog("Cancelling...");
      const target = child;
      target.kill("SIGTERM");
      setTimeout(() => {
        if (child === target) target.kill("SIGKILL");
      }, KILL_AFTER_MS).unref();
      return snapshot();
    },

    /** API shutdown: stop the run and wait (bounded) for the script to clean up. */
    async shutdown() {
      if (run?.status !== "running") return;
      this.cancel();
      let timer;
      const limit = new Promise((resolve) => (timer = setTimeout(resolve, 12_000)));
      await Promise.race([exited, limit]);
      clearTimeout(timer);
    },
  };
}
