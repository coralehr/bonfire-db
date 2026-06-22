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
| 2026-06-22 | BF-01-ci-greptile-pending | 1 | Greptile 5/5 gate failed immediately because no Greptile PR comment, review, or check output existed yet; Bonfire verify and harness syntax passed. | Add bounded Greptile polling, inspect both PR merge and head SHAs, and run harness tests locally/CI. |
| 2026-06-22 | BF-01-ci-greptile-draft | 2 | Greptile app is installed for all ticvision repos, but PR #1 is draft; waiting for final review output on a draft PR is the wrong gate behavior. | Skip Greptile CI for draft PRs and rerun the strict 5/5 gate on ready_for_review. |
| 2026-06-22 | BF-01-ci-greptile-trigger | 3 | Greptile was enabled for bonfire-db after the PR existed; fresh synchronize and failed-job rerun still produced no GitHub-visible Greptile artifact. | Add opt-in URL/comment trigger hooks to the Greptile gate so ready PRs can request review before polling. |
