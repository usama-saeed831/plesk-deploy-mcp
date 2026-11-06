/**
 * The fixed, read-only server checks from references/discovery.md. This one
 * list feeds both server_discovery_commands (a block for the user to run)
 * and server_discover (run over SSH), so the two can never differ. Values are
 * validated by the tools' schemas and then shell-quoted here; everything else
 * in a command is fixed text.
 */
import { readFileSync } from 'node:fs';
import { kitPath } from '../kit.js';
import { shQuote } from '../lib/quote.js';

export type Section =
  'plesk' | 'processes' | 'ports' | 'files' | 'config' | 'data' | 'cron' | 'exposure' | 'release';

export const SECTIONS: readonly Section[] = [
  'plesk',
  'processes',
  'ports',
  'files',
  'config',
  'data',
  'cron',
  'exposure',
  'release',
];

const SECTION_TITLES: Record<Section, string> = {
  plesk: 'Plesk and the OS',
  processes: 'What runs the app today (PM2 lists only the account that started it: run both)',
  ports: 'Ports and the proxy',
  files: 'The files',
  config: 'Configuration (names only, never values)',
  data: 'Data',
  cron: 'Scheduled work',
  exposure: 'Exposure, from anywhere',
  release: 'An existing release manager',
};

export interface DiscoveryParams {
  domain: string;
  app?: string;
  system_user?: string;
  pm2_processes?: string[];
  app_dir?: string;
  env_file?: string;
}

export interface DiscoveryCommand {
  id: string;
  section: Section;
  purpose: string;
  /** The command line. Placeholders like <domain system user> remain when a value is missing. */
  command: string;
  /** Parameters this command needs that weren't given. Such a command is skipped over SSH. */
  missing: string[];
}

/** Prints NAME=<set> or NAME=<empty> for each assignment, and nothing else (not even continuation lines). */
const ENV_NAMES_SED =
  "sed -nE -e 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=[[:space:]]*$/\\2=<empty>/p' -e t " +
  "-e 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\\2=<set>/p'";

export function discoveryCommands(p: DiscoveryParams): DiscoveryCommand[] {
  const commands: DiscoveryCommand[] = [];
  const add = (
    id: string,
    section: Section,
    purpose: string,
    build: (v: (key: keyof DiscoveryParams, placeholder: string) => string) => string,
  ) => {
    const missing: string[] = [];
    const v = (key: keyof DiscoveryParams, placeholder: string) => {
      const value = p[key];
      if (typeof value === 'string' && value) return shQuote(value);
      missing.push(key);
      return `<${placeholder}>`;
    };
    commands.push({ id, section, purpose, command: build(v), missing });
  };
  const d = shQuote(p.domain);
  const vhost = (rest: string) => shQuote(`/var/www/vhosts/${p.domain}${rest}`);

  add('plesk-version', 'plesk', 'Plesk version', () => 'plesk version');
  add('os', 'plesk', 'The operating system', () => "sed -n '1,3p' /etc/os-release");
  add('sites', 'plesk', 'Every domain and subdomain on this server', () => 'plesk bin site --list');
  add(
    'subscription',
    'plesk',
    'Owner, system user and hosting type (look for "FTP Login", "Hosting type")',
    () => `plesk bin subscription --info ${d}`,
  );

  add(
    'pm2-current',
    'processes',
    'PM2 processes of the account running these commands',
    () => 'pm2 ls',
  );
  add(
    'pm2-user',
    'processes',
    "PM2 processes of the domain's system user (PM2 lists only its own)",
    (v) => `sudo -n -u ${v('system_user', 'domain system user')} pm2 ls`,
  );
  const names = p.pm2_processes?.length ? p.pm2_processes : [undefined];
  names.forEach((name, i) => {
    add(
      `pm2-info-${name ?? i}`,
      'processes',
      'Where a PM2 process runs from, and on which Node',
      () =>
        `pm2 info ${name ? shQuote(name) : '<process name>'} | grep -E 'exec cwd|script path|node.js version|interpreter|exec mode'`,
    );
    if (!name) commands[commands.length - 1]!.missing.push('pm2_processes');
  });
  add(
    'services',
    'processes',
    'systemd services that look like the app, PHP or workers',
    () =>
      `systemctl list-units --type=service --no-pager | grep -Ei ${shQuote(`node|pm2|php|queue|worker${p.app ? `|${p.app}` : ''}`)}`,
  );
  add(
    'runtimes',
    'processes',
    "Plesk's Node and PHP builds",
    () => 'ls /opt/plesk/node/ /opt/plesk/php/ 2>/dev/null',
  );
  add(
    'which',
    'processes',
    'Which node, pm2, php and composer are on PATH',
    () => 'command -v node pm2 php composer; node -v',
  );

  add(
    'listening',
    'ports',
    'Which local ports the app, nginx and databases listen on',
    () => "ss -ltnp | grep -E 'node|php|nginx|httpd|redis|postgres|mysql'",
  );
  add(
    'vhost-conf',
    'ports',
    "The domain's generated configuration files",
    () => `ls -la ${shQuote(`/var/www/vhosts/system/${p.domain}/conf/`)}`,
  );
  add(
    'nginx-directives',
    'ports',
    'The "Additional nginx directives" Plesk applies to the domain',
    () => `cat ${shQuote(`/var/www/vhosts/system/${p.domain}/conf/vhost_nginx.conf`)} 2>/dev/null`,
  );

  add('vhost-home', 'files', "The subscription's home", () => `ls -la ${vhost('/')}`);
  add('httpdocs', 'files', 'The document root', () => `ls -la ${vhost('/httpdocs/')} | head -30`);
  add(
    'httpdocs-owner',
    'files',
    'Owner, group and mode of the document root',
    () => `stat -c '%U:%G %a %n' ${vhost('/httpdocs')}`,
  );
  add('checkout', 'files', 'Is the app folder a git checkout, and is it clean', (v) => {
    const dir = v('app_dir', 'app folder');
    return `git -C ${dir} status --short | head -5; git -C ${dir} log -1 --oneline; git -C ${dir} remote -v`;
  });

  add(
    'env-file',
    'config',
    "The app's env file: owner and mode",
    (v) => `ls -la ${v('env_file', 'path to .env')}`,
  );
  add(
    'env-names',
    'config',
    'The names in the env file, each marked <set> or <empty>; no values, no comments',
    (v) => `${ENV_NAMES_SED} ${v('env_file', 'path to .env')}`,
  );

  add(
    'db-clients',
    'data',
    'Database and Redis clients, and whether Redis answers',
    () => 'psql --version 2>/dev/null; mysql --version 2>/dev/null; redis-cli ping 2>/dev/null',
  );
  add(
    'databases',
    'data',
    'Databases as Plesk names them (it may add a prefix)',
    () => 'plesk bin database --list 2>/dev/null',
  );

  add(
    'crontab-current',
    'cron',
    'Scheduled tasks of the account running these commands',
    () => 'crontab -l 2>/dev/null',
  );
  add(
    'crontab-user',
    'cron',
    "Scheduled tasks of the domain's system user (Plesk Scheduled Tasks)",
    (v) => `crontab -l -u ${v('system_user', 'domain system user')} 2>/dev/null`,
  );
  add('cron-d', 'cron', 'System cron files', () => 'ls /etc/cron.d/');

  add(
    'dotenv',
    'exposure',
    'Should be 403 or 404',
    () => `curl -sI ${shQuote(`https://${p.domain}/.env`)} | head -1`,
  );
  add(
    'dotgit',
    'exposure',
    'Should be 403 or 404',
    () => `curl -sI ${shQuote(`https://${p.domain}/.git/config`)} | head -1`,
  );

  if (p.app) {
    add(
      'release-manager',
      'release',
      'Is a release manager already installed for this app',
      () =>
        `ls -l ${shQuote(`/usr/local/bin/${p.app}-deploy`)} ${shQuote(`/etc/${p.app}/deploy.conf`)} 2>/dev/null`,
    );
  }
  return commands;
}

export function sectionTitle(section: Section): string {
  return SECTION_TITLES[section];
}

/** The commands as one block, grouped by section, with a comment on each. */
export function commandBlock(commands: DiscoveryCommand[]): string {
  const lines: string[] = [];
  for (const section of SECTIONS) {
    const inSection = commands.filter((c) => c.section === section);
    if (!inSection.length) continue;
    lines.push(`# --- ${SECTION_TITLES[section]}`);
    for (const c of inSection) lines.push(`# ${c.purpose}`, c.command);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** The "What you are looking for" notes from references/discovery.md, verbatim. */
export function lookingFor(): string {
  const text = readFileSync(kitPath('references', 'discovery.md'), 'utf8');
  const match = /What you are looking for:\n([\s\S]*?)\n## /.exec(text);
  return match?.[1]?.trim() ?? '';
}
