import { describe, expect, it } from 'vitest';
import { call, connect, testConfig } from '../helpers/client.js';

type Seen = { url: string; headers: Record<string, string> };

/** A fetch stand-in that records requests and answers from a table of URL fragments. */
function fakeFetch(
  routes: [string, number, unknown, Record<string, string>?][],
  seen: Seen[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const route = routes.find(([fragment]) => url.includes(fragment));
    if (!route) return new Response('{}', { status: 404, statusText: 'Not Found' });
    const [, status, body, headers] = route;
    return new Response(JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers,
    });
  }) as typeof fetch;
}

const RUNS = {
  workflow_runs: [
    {
      id: 11,
      run_number: 42,
      display_title: 'Fix checkout',
      event: 'push',
      status: 'waiting',
      conclusion: null,
      head_branch: 'main',
      head_sha: '3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345',
      created_at: '2026-11-06T10:00:00Z',
      html_url: 'https://github.com/o/r/actions/runs/11',
    },
    {
      id: 10,
      run_number: 41,
      display_title: 'Add page',
      event: 'push',
      status: 'completed',
      conclusion: 'failure',
      head_branch: 'main',
      head_sha: 'aaaaaaa1b7d4e5f60718293a4b5c6d7e8f9012345',
      created_at: '2026-11-05T10:00:00Z',
      html_url: 'https://github.com/o/r/actions/runs/10',
    },
  ],
};
const JOBS = {
  '/runs/11/jobs': {
    jobs: [
      { name: 'Tests / unit', status: 'completed', conclusion: 'success' },
      { name: 'Deploy to production', status: 'waiting', conclusion: null },
    ],
  },
  '/runs/10/jobs': {
    jobs: [{ name: 'Release bundle', status: 'completed', conclusion: 'failure' }],
  },
};

async function session(
  token?: string,
  routes?: [string, number, unknown, Record<string, string>?][],
) {
  const seen: Seen[] = [];
  const all = routes ?? [
    ['/runs/11/jobs', 200, JOBS['/runs/11/jobs']],
    ['/runs/10/jobs', 200, JOBS['/runs/10/jobs']],
    ['/actions/workflows/deploy-plesk.yml/runs', 200, RUNS],
  ];
  const s = await connect(
    testConfig({ fetch: fakeFetch(all, seen), ...(token ? { githubToken: token } : {}) }),
  );
  return { ...s, seen };
}

describe('github_deploy_runs', () => {
  it('is read-only and open-world', async () => {
    const s = await session();
    const { tools } = await s.client.listTools();
    expect(tools.find((t) => t.name === 'github_deploy_runs')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    await s.close();
  });

  it('lists runs with their jobs, and flags the one waiting for approval', async () => {
    const s = await session();
    const r = await call<{
      runs: {
        run_number: number;
        waiting_for_approval: boolean;
        conclusion: string | null;
        jobs?: { name: string }[];
      }[];
    }>(s.client, 'github_deploy_runs', { repo: 'o/r', branch: 'main', limit: 2 });
    expect(r.isError, r.text).toBe(false);
    expect(
      r.structured.runs.map((x) => [x.run_number, x.waiting_for_approval, x.conclusion]),
    ).toEqual([
      [42, true, null],
      [41, false, 'failure'],
    ]);
    expect(r.structured.runs[0]?.jobs?.map((j) => j.name)).toEqual([
      'Tests / unit',
      'Deploy to production',
    ]);
    expect(r.text).toMatch(/#42 \*\*waiting for approval\*\*/);
    expect(r.text).toMatch(/not proof the site works/);
    expect(s.seen[0]?.url).toBe(
      'https://api.github.com/repos/o/r/actions/workflows/deploy-plesk.yml/runs?per_page=2&branch=main',
    );
    expect(s.seen.every((x) => x.url.startsWith('https://api.github.com/'))).toBe(true);
    expect(s.seen[0]?.headers['user-agent']).toMatch(/^plesk-deploy-mcp\//);
    expect(s.seen[0]?.headers.authorization).toBeUndefined();
    await s.close();
  });

  it('sends the token only in the Authorization header, and never returns it', async () => {
    const token = 'ghp_' + 'aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY1234';
    const echo = { workflow_runs: [{ ...RUNS.workflow_runs[0], display_title: `oops ${token}` }] };
    const s = await session(token, [
      ['/jobs', 200, { jobs: [] }],
      ['/runs', 200, echo],
    ]);
    const r = await call(s.client, 'github_deploy_runs', { repo: 'o/r' });
    expect(s.seen[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(r.raw)).not.toContain(token);
    await s.close();
  });

  it.each([
    [404, {}, undefined, /private.*PLESK_DEPLOY_GITHUB_TOKEN/],
    [401, {}, 'tkn', /rejected PLESK_DEPLOY_GITHUB_TOKEN/],
    [403, { 'x-ratelimit-remaining': '0' }, undefined, /rate limit/],
    [500, {}, undefined, /GitHub answered 500/],
  ] as const)('explains a %s', async (status, headers, token, message) => {
    const s = await session(token, [['/runs', status, { message: 'x' }, headers]]);
    const r = await call(s.client, 'github_deploy_runs', { repo: 'o/r' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(message);
    await s.close();
  });

  it('rejects anything that is not owner/name', async () => {
    const s = await session();
    for (const repo of ['o/r/x', '../etc', 'o', 'o/r?x=1', 'https://github.com/o/r']) {
      const r = await s.client
        .callTool({ name: 'github_deploy_runs', arguments: { repo } })
        .catch(() => ({ isError: true }));
      expect((r as { isError?: boolean }).isError, repo).toBe(true);
    }
    expect(s.seen).toEqual([]);
    await s.close();
  });
});
