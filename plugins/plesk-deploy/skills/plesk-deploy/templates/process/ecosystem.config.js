// TEMPLATE — PM2 processes for a server deployed by the release manager.
//
// The release manager copies this file to <BASE>/ecosystem.config.js on every
// deploy, beside `current`. Every path goes through `current`, so the process
// names stay the same from release to release: PM2 reloads the same processes,
// and each (re)start runs whatever `current` points at by then.
//
// ADAPT: names (they must match PM2_APPS in deploy.conf), folders, scripts,
// ports, memory limits. Keep `instances` at what production runs today unless
// the app is known to be safe with more (sessions, sockets, scheduled jobs).
const fs = require('fs');
const path = require('path');

const CURRENT = path.join(__dirname, 'current');

/** The commit `current` was built from, so the health endpoint reports what is live. */
function release() {
  try {
    const match = /^commit=(\S+)$/m.exec(fs.readFileSync(path.join(CURRENT, 'RELEASE.txt'), 'utf8'));
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

const RELEASE_VERSION = release();

module.exports = {
  apps: [
    {
      name: 'myapp-api',
      cwd: path.join(CURRENT, 'api'),
      script: 'dist/main.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      kill_timeout: 10000, // let in-flight requests and jobs finish
      // PORT and every secret come from the .env the release links to, not from here.
      env: { NODE_ENV: 'production', RELEASE_VERSION },
    },
    {
      name: 'myapp-web',
      cwd: path.join(CURRENT, 'web'),
      // Next.js: run its own binary from the release, not a global one.
      script: path.join(CURRENT, 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
      args: 'start -p 3000',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production', RELEASE_VERSION },
    },
    // A queue worker, if there is one:
    // { name: 'myapp-worker', cwd: path.join(CURRENT, 'api'), script: 'dist/worker.js', env: { NODE_ENV: 'production', RELEASE_VERSION } },
    // A Laravel queue worker under PM2:
    // { name: 'myapp-queue', cwd: CURRENT, script: 'artisan', interpreter: '/opt/plesk/php/8.3/bin/php', args: 'queue:work --sleep=3 --tries=3 --max-time=3600' },
  ],
};
