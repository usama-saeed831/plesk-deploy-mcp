import * as z from 'zod';
import { guarded, textResult, ToolError } from '../lib/result.js';
import { gitBranch, repoSlug, workflowFile } from '../lib/validate.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { DATA_NOTE } from './common.js';
import type { ToolModule } from './index.js';

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

interface ApiRun {
  id: number;
  run_number: number;
  display_title?: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  created_at: string;
  html_url: string;
}

interface ApiJob {
  name: string;
  status: string;
  conclusion: string | null;
}

const jobSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const runSchema = z.object({
  id: z.number(),
  run_number: z.number(),
  title: z.string(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  branch: z.string().nullable(),
  commit: z.string(),
  created_at: z.string(),
  url: z.string(),
  waiting_for_approval: z.boolean(),
  jobs: z.array(jobSchema).optional(),
});

export const registerGithubDeployRuns: ToolModule = (server, config) => {
  async function get<T>(path: string, signal: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `${PACKAGE_NAME}/${VERSION}`,
    };
    if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
    let response: Response;
    try {
      response = await config.fetch(`${API}${path}`, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (error) {
      if ((error as Error).name === 'TimeoutError')
        throw new ToolError(`GitHub didn't answer within ${TIMEOUT_MS / 1000} s.`);
      throw new ToolError(`Could not reach GitHub: ${(error as Error).message}`);
    }
    if (response.ok) return (await response.json()) as T;
    if (response.status === 401)
      throw new ToolError(
        'GitHub rejected PLESK_DEPLOY_GITHUB_TOKEN (401). Create a new fine-grained token with Actions: read and Metadata: read.',
      );
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new ToolError(
        `GitHub's rate limit is used up${config.githubToken ? '' : ' (60 requests an hour without a token)'}. Try again later${config.githubToken ? '' : ', or set PLESK_DEPLOY_GITHUB_TOKEN'}.`,
      );
    }
    if (response.status === 404) {
      throw new ToolError(
        config.githubToken
          ? 'Not found: check the repository and the workflow file name, and that the token can read this repository.'
          : 'Not found. If the repository is private, set PLESK_DEPLOY_GITHUB_TOKEN to a read-only fine-grained token (Actions: read, Metadata: read).',
      );
    }
    throw new ToolError(`GitHub answered ${response.status} ${response.statusText}.`);
  }

  server.registerTool(
    'github_deploy_runs',
    {
      title: 'Deploy runs on GitHub',
      description:
        'Reads the recent runs of the "Deploy to Plesk" workflow from the GitHub API: status, conclusion, commit, branch, link, whether a run is waiting for approval in the production environment, and its jobs. Read-only: it never approves, re-runs or cancels anything. For a private repository it uses the read-only token in PLESK_DEPLOY_GITHUB_TOKEN; it never asks for one. Use it to follow a deploy the user started and to see which job failed. A green run is not proof the site works: verify the live URL from outside. ' +
        DATA_NOTE,
      inputSchema: z.object({
        repo: repoSlug,
        workflow: workflowFile.default('deploy-plesk.yml'),
        branch: gitBranch.optional(),
        limit: z.number().int().min(1).max(20).default(5),
        include_jobs: z.boolean().default(true),
      }),
      outputSchema: z.object({ repo: z.string(), workflow: z.string(), runs: z.array(runSchema) }),
      annotations: {
        title: 'Deploy runs on GitHub',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guarded(async ({ repo, workflow, branch, limit, include_jobs }, signal) => {
      const query = new URLSearchParams({ per_page: String(limit) });
      if (branch) query.set('branch', branch);
      const data = await get<{ workflow_runs?: ApiRun[] }>(
        `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`,
        signal,
      );
      const runs = await Promise.all(
        (data.workflow_runs ?? []).slice(0, limit).map(async (r) => {
          const run: z.infer<typeof runSchema> = {
            id: r.id,
            run_number: r.run_number,
            title: r.display_title ?? '',
            event: r.event,
            status: r.status,
            conclusion: r.conclusion,
            branch: r.head_branch,
            commit: r.head_sha,
            created_at: r.created_at,
            url: r.html_url,
            waiting_for_approval: r.status === 'waiting',
          };
          if (include_jobs) {
            const jobs = await get<{ jobs?: ApiJob[] }>(
              `/repos/${repo}/actions/runs/${r.id}/jobs?per_page=50`,
              signal,
            );
            run.jobs = (jobs.jobs ?? []).map((j) => ({
              name: j.name,
              status: j.status,
              conclusion: j.conclusion,
            }));
          }
          return run;
        }),
      );
      const lines = runs.map((r) => {
        const state = r.waiting_for_approval
          ? '**waiting for approval**'
          : (r.conclusion ?? r.status);
        const jobs = r.jobs?.length
          ? `\n  jobs: ${r.jobs.map((j) => `${j.name} (${j.conclusion ?? j.status})`).join(', ')}`
          : '';
        return `- #${r.run_number} ${state}: ${r.title || r.event} on ${r.branch ?? '?'} at ${r.commit.slice(0, 7)}, ${r.created_at}, ${r.url}${jobs}`;
      });
      const text = [
        `## ${workflow} in ${repo}${branch ? ` (${branch})` : ''}`,
        '',
        lines.length ? lines.join('\n') : 'No runs yet.',
        '',
        'A run that succeeded is not proof the site works: check the live URL from outside.',
      ].join('\n');
      return textResult(text, { repo, workflow, runs });
    }),
  );
};
