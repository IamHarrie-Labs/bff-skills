# SKILL_TEMPLATE.md

> Copy this into your skill directory as `SKILL.md`. Fill in every field. The AIBTC validator enforces frontmatter — missing or malformed fields will block your PR.

---

## 1. SKILL.md

```markdown
---
name: your-skill-name
description: One sentence. What does this skill do and why does an agent need it?
author: your-github-username
author_agent: Your AIBTC Agent Name
user-invocable: true
arguments: doctor | run | install-packs
entry: your-skill-name/your-skill-name.ts
requires: [wallet, signing, settings]
tags: [defi, write, mainnet-only, l1, l2, requires-funds]
---

# Your Skill Name

## What it does
2–3 sentences. Describe the capability, not the implementation.

## Why agents need it
What decision or action does this unlock for an autonomous agent?

## Safety notes
- Does this write to chain? Say so explicitly.
- Does it move funds? Warn here.
- Mainnet only? Say so.
- Any irreversible actions? Flag them.

## Commands

### doctor
Checks environment, dependencies, and wallet readiness. Safe to run anytime.
\`\`\`bash
bun run your-skill-name/your-skill-name.ts doctor
\`\`\`

### run
Core execution. Describe what happens step by step.
\`\`\`bash
bun run your-skill-name/your-skill-name.ts run
\`\`\`

### install-packs (if applicable)
\`\`\`bash
bun run your-skill-name/your-skill-name.ts install-packs --pack all
\`\`\`

## Output contract
All outputs are JSON to stdout.

\`\`\`json
{
  "status": "success | error | blocked",
  "action": "what the agent should do next",
  "data": {},
  "error": null
}
\`\`\`

## Known constraints
- Network requirements
- Wallet requirements
- Any edge cases or known failure modes
```

---

## 2. AGENT.md

```markdown
# Agent Behavior — Your Skill Name

## Decision order
1. Run `doctor` first. If it fails, stop and surface the blocker.
2. Confirm intent before any write action.
3. Execute `run`.
4. Parse JSON output and route on `status`.

## Guardrails
- Never proceed past a `blocked` status without explicit user confirmation.
- Never expose secrets or private keys in args or logs.
- Always surface error payloads with a suggested next action.
- Default to safe/read-only behavior when intent is ambiguous.

## Output contract
Return structured JSON every time. No ambiguous success states.

\`\`\`json
{
  "status": "success | error | blocked",
  "action": "next recommended action for the agent",
  "data": {},
  "error": { "code": "", "message": "", "next": "" }
}
\`\`\`

## On error
- Log the error payload
- Do not retry silently
- Surface to user with the `action` field guidance

## On success
- Confirm the on-chain result (tx hash if applicable)
- Update any relevant state
- Report completion with summary
```

---

## Allowed tags (use only from this list)

| Tag | Use when |
|---|---|
| `read-only` | Skill only reads chain state, never writes |
| `write` | Skill submits transactions |
| `mainnet-only` | Will not work on testnet |
| `requires-funds` | Wallet must have STX/sBTC to execute |
| `sensitive` | Handles keys, secrets, or private data |
| `infrastructure` | Foundational primitive other skills can build on |
| `defi` | Interacts with DeFi protocols (Bitflow, Zest, Alex, etc.) |
| `l1` | Operates on Bitcoin L1 |
| `l2` | Operates on Stacks L2 |

---

## Pre-PR checklist

Run these before opening your PR. Paste the output into the PR description.

```bash
# 1. Validate frontmatter
bun run scripts/validate-frontmatter.ts

# 2. Regenerate manifest
bun run scripts/generate-manifest.ts

# 3. Smoke tests — run all three
bun run skills/your-skill-name/your-skill-name.ts doctor
bun run skills/your-skill-name/your-skill-name.ts install-packs --pack all
bun run skills/your-skill-name/your-skill-name.ts run
```

**All three must produce clean JSON output. Attach results to your PR.**

---

## Common rejection reasons

- Vague description or missing safety constraints
- Invalid frontmatter formatting or unknown tag/require values
- No JSON output discipline — ambiguous success states
- Hidden write risk (writes without explicit user intent)
- Weak error handling or non-idempotent behavior
- **No on-chain proof** — this is the most common blocker
