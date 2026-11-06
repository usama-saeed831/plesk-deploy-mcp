# Making the existing CI callable from the deploy workflow

Keep one CI file. Add a `workflow_call` trigger so the deploy workflow can run
it as its "Tests" job against the exact commit being released.

## The trigger

```yaml
on:
  pull_request:
  push:
    branches-ignore: [main]        # main is tested inside Deploy to Plesk
  workflow_call:
    inputs:
      ref:
        description: 'Commit to test (empty: the caller''s commit)'
        type: string
        default: ''
      skip_build:
        description: 'Skip the image/build job (the deploy builds its own bundle)'
        type: boolean
        default: false

permissions:
  contents: read

concurrency:
  # The event name keeps a called run apart from a direct one on the same ref.
  group: ci-${{ github.event_name }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

Excluding main from `push` keeps a push to main from running the tests twice, once
directly and once inside the deploy. If the team wants a standalone CI badge for
main, keep main and accept the duplicate run.

## In every job

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ inputs.ref }}       # empty on pull_request/push: the event's own commit
```

Use `node-version-file: .nvmrc` (or the PHP version the server runs) so tests
run on the same runtime as production.

## The build job

```yaml
build:
  if: ${{ !inputs.skip_build }}
```

## Before you change the triggers

- Read what the existing CI does and keep every check. Making it callable must
  not weaken it.
- Some repositories have tests that read workflow files. Search for the
  workflow's filename in the test folders before you edit it.
- Branch protection rules name status checks by job name. Renaming a job can
  block merges until the rule is updated. Tell the user.
- If a release gate or script asks the GitHub API whether "CI passed on this
  commit", it must also accept a deploy run whose `Tests / …` jobs all passed.
  Tests on main now run inside the deploy workflow.
