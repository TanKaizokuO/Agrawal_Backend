# CLAUDE.md

## Open question: ask this before any other work

PR #55 (`fix/verify-main-issues`) is open and mergeable. It verifies main's fixes on PostgreSQL 18, fixes Blood SOS creates, and brings `deploy/terraform` to main. Open the session by asking the user whether to merge it into `main`. Merging closes the last 7 open issues (#10, #21, #37, #38, #46, #47, #48).

State these two conditions in the same question. They apply before anyone applies the Terraform:

- Run `tofu plan` for each environment with AWS credentials. No plan has run yet.
- Move the container registries (ECR repos) and the web DNS records (apex, `www`, `register`) into the correct environment's state. An existing stack otherwise plans to delete them.

Details: `docs/REMAINING BACKEND WORK.md` §3 AWS. Remove this section once the user decides on the merge.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `TanKaizokuO/Agrawal_Backend`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root, and ADRs in the sibling repo at `../Agrawal_App/docs/adr/`. See `docs/agents/domain.md`.
