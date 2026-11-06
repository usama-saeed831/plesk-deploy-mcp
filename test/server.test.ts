import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KIT_RESOURCES } from '../src/catalog.js';
import { SETUP_PROMPT } from '../src/prompts.js';
import { connect } from './helpers/client.js';

let session: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  session = await connect();
});
afterAll(async () => session.close());

describe('resources', () => {
  it('lists the workflow, 10 references and 12 templates', async () => {
    const { resources } = await session.client.listResources();
    expect(resources).toHaveLength(23);
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(KIT_RESOURCES.map((r) => r.uri)),
    );
    expect(resources.map((r) => r.uri)).toContain('plesk-deploy://templates/server/app-deploy');
    for (const r of resources) {
      expect(r.description, r.uri).toBeTruthy();
      expect(r.mimeType, r.uri).toBeTruthy();
    }
  });

  it('serves every resource with its text and type', async () => {
    for (const r of KIT_RESOURCES) {
      const { contents } = await session.client.readResource({ uri: r.uri });
      expect(contents).toHaveLength(1);
      const item = contents[0] as { uri: string; mimeType?: string; text?: string };
      expect(item.uri).toBe(r.uri);
      expect(item.mimeType).toBe(r.mimeType);
      expect(item.text?.length, r.uri).toBeGreaterThan(100);
    }
  });

  it('serves the workflow without the skill frontmatter, with a note on resource names', async () => {
    const { contents } = await session.client.readResource({ uri: 'plesk-deploy://workflow' });
    const text = (contents[0] as { text: string }).text;
    expect(text.startsWith('---')).toBe(false);
    expect(text).toContain('plesk-deploy://references/<name>');
    expect(text).toContain('## Rules that are never relaxed');
  });
});

describe('prompt', () => {
  it('is listed with its two optional arguments', async () => {
    const { prompts } = await session.client.listPrompts();
    const prompt = prompts.find((p) => p.name === SETUP_PROMPT);
    expect(prompt).toBeDefined();
    expect(prompt?.arguments?.map((a) => a.name).sort()).toEqual(['host_alias', 'project_dir']);
    expect(prompt?.arguments?.every((a) => !a.required)).toBe(true);
  });

  it('walks through the 8 phases, quotes all 10 rules and names the tools', async () => {
    const result = await session.client.getPrompt({ name: SETUP_PROMPT, arguments: {} });
    const text = (result.messages[0]?.content as { text: string }).text;
    for (let rule = 1; rule <= 10; rule++)
      expect(text).toMatch(new RegExp(`^${rule}\\. \\*\\*`, 'm'));
    for (const phase of [1, 2, 3, 4, 5, 6, 7, 8])
      expect(text).toMatch(new RegExp(`^${phase}\\. \\*\\*`, 'm'));
    for (const tool of [
      'inspect_project',
      'server_discovery_commands',
      'server_discover',
      'generate_deploy_kit',
      'validate_deploy_kit',
      'github_deploy_runs',
      'deploy_status',
      'deploy_logs',
      'rollback',
    ]) {
      expect(text).toContain(tool);
    }
    expect(text).toMatch(/Stop here until the user agrees/);
    expect(text).toMatch(/Never build or deploy from this machine/);
  });

  it('uses the arguments it is given', async () => {
    const result = await session.client.getPrompt({
      name: SETUP_PROMPT,
      arguments: { project_dir: '/work/shop', host_alias: 'prod' },
    });
    const text = (result.messages[0]?.content as { text: string }).text;
    expect(text).toContain('/work/shop');
    expect(text).toContain('host_alias "prod"');
  });

  it('rejects an argument that is not a valid alias', async () => {
    await expect(
      session.client.getPrompt({
        name: SETUP_PROMPT,
        arguments: { host_alias: '-oProxyCommand=id' },
      }),
    ).rejects.toThrow();
  });
});

describe('server', () => {
  it('identifies itself and gives instructions', () => {
    const info = session.client.getServerVersion();
    expect(info?.name).toBe('plesk-deploy-mcp');
    expect(session.client.getInstructions()).toMatch(/setup-plesk-deployment/);
  });
});
