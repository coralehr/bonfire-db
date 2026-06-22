# Bonfire Loop State

This is the memory spine for the Bonfire autonomous build loop. Keep it
synthetic-only and secret-free. Reference PRs, commits, files, and loop item ids;
never paste real patient data, credentials, logs with secrets, or private
customer material.

_last run: never_

## Inbox

| date | key | source | sev | title | suggested action | status |
|------|-----|--------|-----|-------|------------------|--------|

<!-- Append new findings above this line. One row per finding. Do not rewrite existing rows unless closing or correcting a specific key. -->

## Active

| date | key | branch | owner | acceptance | status |
|------|-----|--------|-------|------------|--------|

## Done

| date closed | key | title | how | ref |
|-------------|-----|-------|-----|-----|

## Failed Attempts

| date | key | attempt | failure | next action |
|------|-----|---------|---------|-------------|
| 2026-06-22 | BF-01-ci-watch-no-checks | 6 | Immediately after pushing b262080, `gh pr checks` returned non-zero with `no checks reported on the 'loop/BF-01' branch` before GitHub created the new check suite. | Treat `no checks reported` as a pending CI state in the watcher so the loop waits instead of stopping. |
| 2026-06-22 | BF-01-ci-greptile-token | 5 | CI run 27974607210 passed Harness syntax and Bonfire verify but Greptile gate failed in 8s because `GITHUB_TOKEN` could not post the default trigger comment: HTTP 403 Resource not accessible by integration. | Do not require default comment-trigger success in CI unless a working Greptile trigger token/URL is configured; keep polling for Greptile app output and make CI watcher wait for failed-job logs when the run is still in progress. |
| 2026-06-22 | BF-01-ci-greptile-score | 4 | Latest CI run 27972158797 passed Harness syntax and Bonfire verify but failed Greptile 5/5 gate after Greptile scored commit 9b4b3fa at 3/5 for scaffold and harness defects. | Fix the review findings and add a CI watcher that polls PR checks and extracts failing GitHub Actions log snippets for the next repair loop. |
| 2026-06-22 | BF-01-ci-greptile-pending | 1 | Greptile 5/5 gate failed immediately because no Greptile PR comment, review, or check output existed yet; Bonfire verify and harness syntax passed. | Add bounded Greptile polling, inspect both PR merge and head SHAs, and run harness tests locally/CI. |
| 2026-06-22 | BF-01-ci-greptile-draft | 2 | Greptile app is installed for all ticvision repos, but PR #1 is draft; waiting for final review output on a draft PR is the wrong gate behavior. | Skip Greptile CI for draft PRs and rerun the strict 5/5 gate on ready_for_review. |
| 2026-06-22 | BF-01-ci-greptile-trigger | 3 | Greptile was enabled for bonfire-db after the PR existed; fresh synchronize and failed-job rerun still produced no GitHub-visible Greptile artifact. | Add opt-in URL/comment trigger hooks to the Greptile gate so ready PRs can request review before polling. |
