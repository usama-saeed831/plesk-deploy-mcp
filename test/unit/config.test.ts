import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('has the SSH tools off by default', () => {
    const c = loadConfig({});
    expect(c.allowedHosts).toEqual([]);
    expect(c.sshBin).toBe('ssh');
    expect(c.githubToken).toBeUndefined();
  });

  it('reads comma-separated aliases and ignores malformed entries whole', () => {
    const c = loadConfig({
      PLESK_DEPLOY_SSH_HOSTS: ' prod , staging,prod, bad alias!, -oProxyCommand=x ',
    });
    expect(c.allowedHosts).toEqual(['prod', 'staging']);
    expect(c.ignoredHosts).toEqual(['bad alias!', '-oProxyCommand=x']);
  });

  it('only uses an absolute CLAUDE_PROJECT_DIR', () => {
    expect(loadConfig({ CLAUDE_PROJECT_DIR: '/work/shop' }).defaultProjectDir).toBe('/work/shop');
    expect(loadConfig({ CLAUDE_PROJECT_DIR: 'relative' }).defaultProjectDir).toBeUndefined();
  });

  it('keeps the GitHub token out of the environment child processes get', () => {
    const c = loadConfig({ PATH: '/usr/bin', PLESK_DEPLOY_GITHUB_TOKEN: ' tkn ' });
    expect(c.githubToken).toBe('tkn');
    expect(Object.keys(c.childEnv)).toEqual(['PATH']);
  });
});

describe('placeholders a client left unsubstituted', () => {
  it('are treated as unset, never as a host or a token', () => {
    const c = loadConfig({
      PLESK_DEPLOY_SSH_HOSTS: '${user_config.ssh_hosts}',
      PLESK_DEPLOY_GITHUB_TOKEN: '${user_config.github_token}',
      PLESK_DEPLOY_SSH_BIN: '',
    });
    expect(c.allowedHosts).toEqual([]);
    expect(c.ignoredHosts).toEqual([]);
    expect(c.githubToken).toBeUndefined();
    expect(c.sshBin).toBe('ssh');
  });
});
