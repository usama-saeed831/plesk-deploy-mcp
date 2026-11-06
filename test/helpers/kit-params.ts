import type { KitParams } from '../../src/kit/render.js';

/** A complete Node + PM2 + PostgreSQL configuration, as an agent would pass it. */
export const NODE_PM2 = {
  app: 'acme',
  stack: 'node',
  process_manager: 'pm2',
  site_url: 'https://example.com/',
  public_health_url: 'https://example.com/health',
  base_dir: '/var/www/acme-app',
  health_checks: [{ url: 'http://127.0.0.1:3001/health/ready', contains: '"status":"ready"' }],
  health_commit_url: 'http://127.0.0.1:3001/health/ready',
  app_user: 'acme_sys',
  app_group: 'psacln',
  node_bin_dir: '/opt/plesk/node/24/bin',
  pm2_apps: [{ name: 'acme-api', dir: '.', script: 'dist/main.js' }],
  database: 'postgres',
  migrate_cmd:
    'NODE_ENV=production node node_modules/typeorm/cli.js migration:run -d dist/data-source.js',
  build_time_vars: ['NEXT_PUBLIC_API_URL'],
  runtime_env_names: ['NODE_ENV', 'PORT', 'DATABASE_URL', 'JWT_SECRET'],
} as const;

/** The defaults the tool's schema fills in, for calling renderKit directly. */
export function params(overrides: Partial<KitParams> = {}): KitParams {
  const defaults: Partial<KitParams> = {
    branch: 'main',
    ci_workflow: 'ci.yml',
    database: 'none',
    build_time_vars: [],
    runtime_env_names: [],
    not_deployed_paths: ['docs/'],
    nginx: 'none',
  };
  const base = JSON.parse(JSON.stringify(NODE_PM2)) as Partial<KitParams>;
  return { ...defaults, ...base, ...overrides } as KitParams;
}
