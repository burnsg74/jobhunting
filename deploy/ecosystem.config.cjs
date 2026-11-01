const path = require("node:path");

// Same node the old jobs app used (fnm). Override with JOBHUNTING_NODE if it moves.
const node =
  process.env.JOBHUNTING_NODE ||
  "/Users/greg/.local/share/fnm/node-versions/v24.18.1/installation/bin/node";

const root = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      name: "jobhunting-api",
      cwd: root,
      script: "backend/main.js",
      interpreter: node,
      // Optional gitignored overrides (VAULT_PATH, DATA_DIR, PORT).
      node_args: "--env-file-if-exists=.env.production",
      exec_mode: "fork",
      autorestart: true,
      // A running Wellfound pull must be allowed to kill its Chrome-Remote instance on shutdown.
      kill_timeout: 20000,
      env: {
        NODE_ENV: "production",
        PORT: "4002",
      },
    },
  ],
};
