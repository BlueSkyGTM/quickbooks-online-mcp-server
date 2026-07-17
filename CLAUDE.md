# QB Server

QuickBooks Surface A: the firm's fork of Intuit's open-source MCP server. It exposes
the core ledger (accounts, journal entries, attachments, reports) to the workbench
pipelines, and it ships the flags the safety gate depends on.

This workspace is the server plus its operations. Everything below the fold is
upstream's code, not ours; our jobs are the three repeatable ones named here.

## What this is, in the topology

| Fact | Value |
|------|-------|
| Our fork | `BlueSkyGTM/quickbooks-online-mcp-server` (remote `origin`) |
| Upstream | `intuit/quickbooks-online-mcp-server` (remote `upstream`) |
| This is its own git repository | Nested here physically; the root repo ignores this directory |
| Registered as | `quickbooks-surface-a` in the root `.mcp.json` |
| Surface B (hosted connector) | Not here. Payroll and transaction import live on the hosted Intuit connector, authorized in Claude settings |

## One company at a time, by design

This server binds to **one QuickBooks company for the life of the process**. The realm
is read once at module load, and `.env` overrides anything the host's MCP config
injects, so a realm cannot be passed per registration or per call. That is a
constraint of the code, and we run with it rather than around it:

**Exactly one client's books are reachable at any moment.** Posting client A's entry
into client B's ledger is not prevented by policy or by the agent paying attention; it
is impossible, because B is not connected. This is the firm's "separate lanes" rule
enforced by the process boundary.

The cost is a session restart to switch lanes. That is the price of the guarantee.

## Lane credentials

Each lane's credentials live in `.env.<lane>.local` in this folder, and the active
lane is a copy of one of them at `.env`.

Naming is not cosmetic: this repository is a **public** fork. Its `.gitignore` covers
`.env` and `.env.*.local` and nothing else. `env/`, `credentials/`, and `.env.backup`
are **not** ignored and would publish live credentials. Verify with
`git check-ignore -v <file>` before writing any file that holds a secret.

| File | Lane |
|------|------|
| `.env` | whichever lane is currently active |
| `.env.qbo-sandbox.local` | qbo-sandbox (realm 9341457533545558) |

## Repeatable jobs

### 1. Authorize a lane (once per company, or when its tokens expire)

Two traps, both silent. Read them before running anything.

**Trap 1: `npm run auth` is a no-op when a refresh token already exists, and still
prints success.** `auth-server.ts` calls `authenticate()`, which only starts the OAuth
flow when there is no refresh token; otherwise it just refreshes the existing token
and returns. The script then prints "Successfully authenticated" and "Tokens have been
saved to your .env file" unconditionally — both false. Nothing is written, no consent
screen appears, and you are still connected to the previous lane. **You must clear
`QUICKBOOKS_REFRESH_TOKEN` and `QUICKBOOKS_REALM_ID` before authorizing a different
company.**

**Trap 2: the flow writes tokens into `.env`, overwriting whatever lane was there.**
Back up the active lane first or lose its connection.

Never trust the success message. Verify by realm, every time.

1. Create or identify the company in the Intuit developer portal. One app authorizes
   many companies; the client id and secret stay the same across lanes.
2. Back up the active lane: copy `.env` to `.env.<current-lane>.local` if not already
   saved.
3. In `.env`, keep `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET`; blank
   `QUICKBOOKS_REFRESH_TOKEN` and `QUICKBOOKS_REALM_ID`. This is what forces a real
   authorization (trap 1).
4. `npm run auth`. **A consent screen must appear** — its absence means the flow
   short-circuited and nothing happened. Pick the intended company; that choice is
   what this lane will reach.
5. Verify the realm in `.env` is the company you meant, and that the refresh token
   changed. The success message alone proves nothing.
6. Save the result: copy `.env` to `.env.<new-lane>.local`.
7. Record the realm id and the company name (read it back from the API, do not assume)
   in that lane's config under `fb-workbench/lanes/<lane>/`.

Trap 1 is an upstream bug, not our configuration. The honest fix is a patch offered
upstream (the message should reflect whether an authorization happened), not a local
edit to this file — a local edit diverges the one file whose merges we most need to
stay reviewable. Until then, the procedure above is the workaround.

### 2. Point at a lane (before any run)

1. Copy `.env.<lane>.local` over `.env`.
2. Restart the Claude session so the server reloads with that lane's realm.
3. **Verify before trusting it**: read the company info and confirm the returned
   company is the lane you intend, and that its realm matches the lane config's QBO
   company id. Stage 01 repeats this check as an audit; do not skip it here on the
   assumption the copy worked.

### 3. Gate verification (after any auth, lane switch, or flag change)

The gate is only real if the flags actually bite. Verify both directions:

- A read succeeds: fetch the company info or search accounts.
- A write is refused: the create tools are not registered at all when
  `QUICKBOOKS_DISABLE_WRITE=true`. Their absence is the pass condition.

If a create tool is present while the flag is set, stop and fix it before any pipeline
run. See `../fb-workbench/pipelines/schedule-journal-entries/shared/gate-rules.md` for
what the gate means; this file is only how to check it.

### 4. Upstream ingestion loop (a safety control, not a chore)

**Never merge upstream blind.** A blind merge is an unreviewed change to the firm's
safety posture, for three reasons:

- The three `QUICKBOOKS_DISABLE_*` flags are the foundation of the gate. If upstream
  changes what they suppress, or registers a tool outside them, the gate weakens
  silently and nothing announces it.
- This source is the one artifact where our capability claims can be `extracted` rather
  than `inferred`. It is the ground truth the crosswalk and the `/qb-mcp` skill describe.
- The Surface A/B boundary is a fact about *this code*, not a permanent truth. If
  upstream adds transaction import or recurring invoices to the local server, our
  routing law changes that day.

Run it **before each cycle**, and any time we are about to rely on a capability claim we
have not re-checked.

#### The loop

1. `git fetch upstream`. No new commits: log the check and stop. An empty delta is a
   valid result, not a wasted run.
2. Diff against the merge base, scoped to what matters: `src/tools/`, `src/handlers/`,
   and the registration and gating path (`src/helpers/register-tool.ts`).
3. Compile the capability delta: tools added, removed, or changed signature; gating
   behavior changed; **absences that closed** - call out surface-routing impact
   explicitly, since an absence closing is what silently invalidates the crosswalk.
4. Audit, with hard pass conditions:
   - Do the three DISABLE flags still suppress the same categories?
   - Does any new tool register **outside** the gate? (See the prefix caveat below.)
   - Do the account-entity tools still exist as the unconditional-block target?
5. Emit the delta as a review file at
   `../fb-workbench/reports/upstream-deltas/YYYY-MM-DD-<range>.md`. **Never merge before
   the operator reads it** - same gate as everything else.
   (It lives in the workbench because the root repository ignores this directory, so no
   tracked artifact can live here. Noted as a wart, not a preference.)
6. On approval: merge, rebuild, re-run gate verification (job 3), then ingest the delta
   into the brain's core - update the crosswalk and capability pages, provenance
   `extracted` (read from source), citing the commit range as the raw source.
7. **Flag the skill.** `/qb-mcp` bundles its own capability reference and cannot
   self-update. If a delta touches anything that reference asserts, say so explicitly:
   that is a skill edit only the operator can make. Law that silently drifts from reality
   is worse than no law.

#### The prefix caveat, which is the whole reason step 4 exists

Gating is by **name prefix**, not by any structural property. `getCrudCategory` matches
six literal prefixes (`create_`, `create-`, `update_`, `update-`, `delete_`, `delete-`)
and **defaults everything else to READ**, and READ is never disabled.

So a mutating tool whose name starts with anything else - `send_`, `void_`, `post_`,
`batch_` - registers even with all three flags `true`. The gate's safety rests on
upstream's naming discipline, which is a convention we do not control.

Baseline as of upstream `0993518`: 141 tools, 71 gated, 70 ungated, and every ungated
tool is a `get`/`search`/`read`. The gate holds today. Step 4 exists because it holds by
habit rather than by construction.

## The flags

`QUICKBOOKS_DISABLE_WRITE`, `QUICKBOOKS_DISABLE_UPDATE`, `QUICKBOOKS_DISABLE_DELETE`
live in `.env`, all `true` by default. They are turned off deliberately, by the
operator, for one posting session, and turned back on after. No pipeline turns them
off on its own.
