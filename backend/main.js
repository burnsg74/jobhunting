// Entry point (pm2 and `npm start`). Binds loopback only.
import { resolveConfig } from "./config.js";
import { createApp } from "./server.js";

const config = resolveConfig();
const server = createApp(config);

server.listen(config.port, "127.0.0.1", () => {
  console.log(`jobhunting-api ${config.mode} on http://127.0.0.1:${config.port}  data: ${config.dir}`);
});

// Stop a running pull first: its `finally` kills the Chrome-Remote instance.
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => process.exit(0), 15_000);
  force.unref();
  try {
    await server.pulls.shutdown();
  } finally {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
