# Two-person approved-version pin

This is a real two-GitHub-account run on a **shared test repo**. It is not
CI. Capture the evidence listed at the end.

## Repo and access

| | |
| --- | --- |
| Test repo | **`Nareik33L/grane-pin-two-person`** (create empty, default branch `main`) |
| Account A (approver) | Write + **Allow merge** on that repo (collaborator or owner) |
| Account B (verifier) | **Write** collaborator (clone, pull, and optionally open/merge PRs). Read is enough if B only verifies after A merges. |

Do **not** use the product repo `Nareik33L/grane` for this drill. The second
account must be added under **Settings → Collaborators** on
`Nareik33L/grane-pin-two-person`. No npm publish, no release tags.

## Prerequisites

Both accounts have `git`, `gh` (authenticated to their own user), and a
checkout of Grane that can run:

```bash
npx tsx src/cli/index.ts -p /path/to/grane-pin-two-person …
```

`git user.name` / `user.email` set in each clone.

## Script

### Account A — suggest

```bash
git clone git@github.com:Nareik33L/grane-pin-two-person.git
cd grane-pin-two-person
# add grane.yml + metrics.yml (valid shop YAML), commit, push main
npx tsx /path/to/grane/src/cli/index.ts -p . proposals   # or authoring submit_proposal
# open the printed `gh pr create --base main --head grane/proposal/…`
```

Merge the **proposal** PR on GitHub (`gh pr merge` as a human, not Grane).
Merge, squash, or rebase are all valid: `proposals approve` pins that
proposal's merged commit on `main` (the merge commit, or the squash/rebase
commit whose metric YAML matches), not a later tip. If no matching commit
is reachable from `main`, it refuses instead of pinning silently. Known
limit: the same YAML committed straight to `main` (no PR) also matches;
branch protection and T2 close that
([team-setup.md](team-setup.md)).

### Account A — approve (does not merge the pin)

```bash
git checkout main && git pull
npx tsx /path/to/grane/src/cli/index.ts -p . proposals approve <id> --approved-by "$GITHUB_USER"
# prints: gh pr create --base main --head grane/pin/…
# Grane does not run gh, git push of main, or git merge of main
```

Push the pin branch if needed (`git push -u origin grane/pin/…`) and run the
printed `gh pr create`. Merge the **pin** PR as a human.

### Account B — pull, same version

```bash
git clone git@github.com:Nareik33L/grane-pin-two-person.git
cd grane-pin-two-person
git pull
npx tsx /path/to/grane/src/cli/index.ts -p . doctor --json
# serve uses loadServingConfig / `grane serve`
```

Account B must see the same `grane.pin.json` `commit`, the same metric names,
and the same `config_hash` as Account A after both have pulled the merged
pin PR.

## Evidence to capture

1. Proposal PR URL (yaml) and pin PR URL (`grane.pin.json` only).
2. `git log origin/main --oneline` on both clones after the pin PR merge.
3. `cat grane.pin.json` on A and B (same `commit`).
4. Catalog / doctor JSON: `active.commit` and `config_hash` equal.
5. Confirm Grane never pushed or merged `main` during `proposals approve`
   (only printed `gh pr create`).
6. Optional divergence: B skips `git pull`, runs `grane doctor` — warning
   that origin differs; B still serves the last good local pin.

CI already covers a no-network analogue (`tests/unit/tracked-pin.test.ts`)
with a bare origin and clones A and B.
