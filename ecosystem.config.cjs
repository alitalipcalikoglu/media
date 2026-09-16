// PM2 process file for this service. CommonJS on purpose: PM2 loads config files with require().
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     # persist across reboots
// Environment comes from ./.env via Node's --env-file, so secrets never sit in this file.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'media',
      cwd: __dirname,
      script: 'src/index.js',
      node_args: ['--disable-warning=ExperimentalWarning', `--env-file=${path.join(__dirname, '.env')}`],
      exec_mode: 'fork',
      instances: 1,             // one process per SQLite file and data directory
      autorestart: true,
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      max_memory_restart: '600M',  // sharp decodes large images in memory
      wait_ready: true,         // process.send('ready') after listen()
      listen_timeout: 10000,
      kill_timeout: 65000,      // SIGTERM → finish in-flight uploads/downloads → exit (internal force-exit at 60s)
      merge_logs: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
