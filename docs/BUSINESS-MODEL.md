# Agent Rewind — business model & protection (research-grounded 2026-08-18)

Grounded in two verified research passes (licence/protectability `wlwjzoq7a`; deep-research
`wuoiazto1`, 22/25 claims confirmed by 3-vote adversarial verification). Licence rationale is in
`docs/LICENCE-DECISION.md`; billing metering integrity is in `docs/SAVINGS-RECEIPT.md`.

## The decision, in one line

**Proprietary by LICENCE + HOSTING, not by secrecy.** Ship the client under FSL-1.1-Apache-2.0
(legally no one can build a rival on it); keep the money-making + must-be-trusted pieces on a closed
hosted service. You cannot hide code that runs on the user's machine — so don't try; protect the
revenue instead.

## Why "hide the code" was the wrong axis (verified)

- Bun/Node-SEA single-file binaries **do not hide source** — public zero-dep extractors pull the JS
  wholesale; **Claude Code's own 10.9 MB and Factory Droid's 14.1 MB were extracted** this way. Bun's
  docs: bytecode "doesn't obscure source code." (deep-research, 3-0)
- A licence/entitlement check that runs **only on the client is bypassable** (CWE-602, MITRE):
  "client-side checks for authentication can be easily bypassed." Genuine gating must be **server-side**.
  (3-0)
- Signed **offline** keys are tamper-**evident**, not tamper-**proof**, and can't be revoked/renewed
  without connectivity. (3-0; the "offline files are tamper-proof gating" claim was refuted 0-3.)

## The architecture that sells access

| Layer | Where it runs | Licence / secrecy | Role |
|---|---|---|---|
| `@agent-rewind/core` + `@agent-rewind/mcp` (barrier, chain, local git rewind, effect capture, local savings meter) | **User's machine** | **FSL-1.1-Apache-2.0** — source-available, no competing product, → Apache-2.0 in 2 yrs | The free, viral, offline wedge. Readable but legally protected. |
| Entitlement / license validation | **Hosted (closed)** | fully closed | The real access gate (client checks are bypassable). |
| Savings verification + billing meter | **Hosted (closed)** | fully closed | Computes the billable number server-side so it can't be gamed. |
| Team dashboard, cross-machine sync, aggregate savings data | **Hosted (closed)** | fully closed | The paid product + the data flywheel. |
| Athena authority resolver | **Private (Athena repo)** | fully closed | Injected via the seam; never in `@agent-rewind/core`. |

Free tier = local + FSL (account-free, zero-marginal-cost, viral). Paid tier = server-gated.

## The pricing model: gainshare on token savings

**Precedent is real:** ProsperOps "Savings Share" charges **10–15% of realized cloud savings**, paid out
of the savings themselves (Zesty similar). So a %-of-savings model is proven — but **10% is at the floor**
of the 10–50% gainshare band; little room to discount. Consider **10–15%**.

**Structure it as a HYBRID, not pure %-of-savings.** Pure outcome-pricing is rare (4 of 65 companies);
**72% run hybrids** (base + usage). Recommended:
- A **modest base fee** (cuts cash volatility, underwrites capacity) **+ ~10–15% of verified savings**.
- **Caps** (protect the buyer from a runaway bill) + **floors** (protect Agent Rewind) + **tiered collars**
  (lower share at small savings, higher as impact scales).
- **Self-serve (npx) = flat/capped tier; gainshare reserved for contracted enterprise accounts** —
  audit rights / true-ups only bite in a signed agreement (open question from the research).

## The hard, honest risk — and Agent Rewind's edge

**"Savings" = baseline − actual, and the counterfactual baseline (what they'd have spent WITHOUT Agent Rewind)
is unobservable and gameable by both sides.** The canonical warning is Medicare ACOs: large shared-savings
payouts on savings that counterfactual analysis found "modest to non-existent." Buyers are incentivized to
**under-report** value to lower the bill (L.E.K.).

- **What crypto CAN do:** attest **actual usage** (ZK-proof of token counts faithfully extracted from the
  provider's authenticated response — TrustedARI precedent). What it **cannot** do: anchor the
  counterfactual baseline (refuted 0-3 — do not claim the metric is "cryptographically unforgeable").
- **So baseline integrity is a governance problem:** locked/normalized baseline under change control,
  server-side computation, audit rights, third-party assurance, periodic true-ups.
- **Agent Rewind's genuine advantage:** unlike cloud-cost tools, Agent Rewind's savings are **measured avoided
  re-spend**, not a hypothetical — a replay cache-hit is a *real* avoided API call with a *real* token
  count (recorded response returned without calling the provider). **Count ONLY provably-avoided
  re-spend** (never a whole failed run) and the number becomes far more defensible. The tamper-evident
  hash chain is the anti-tamper substrate; the honest-counterfactual metering (`SAVINGS-RECEIPT.md`) is
  the invoice integrity. Attribution ("would the agent have re-run anyway?") keeps a soft edge — price and
  contract for it; don't pretend it's solved.

## Open questions to validate with the first customers

1. A defensible, low-dispute counterfactual baseline (held-out sessions? shadow runs?) — the single
   biggest unresolved risk to the 10% model.
2. Does %-of-savings face buyer resistance in AI-dev-tools specifically? No direct precedent surfaced.
3. Self-serve vs enterprise split for where gainshare is even enforceable.
