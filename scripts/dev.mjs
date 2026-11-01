// Runs the API (node --watch, dev data) and Vite together. Ctrl-C stops both.
import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev:api"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:web"], { stdio: "inherit" }),
];

function stop() {
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) {
  child.on("exit", () => {
    stop();
    process.exit();
  });
}
