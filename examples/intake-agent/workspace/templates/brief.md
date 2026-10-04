# <Title: verb + object, under 70 characters>

Label: `agent-ready` | `needs-decision`
Requested by: <colleague> in Discord thread <link>
Size: S | M | L. <One line of reasoning.>

## Goal

<One sentence: who gets what benefit.>

## Current behavior

<What the code does today. Cite files and functions, for example `src/orders/export.ts` `exportOrders()`. Say what tests exist.>

## Desired behavior

<The change as the user experiences it. Screens, commands, outputs. No implementation choices unless they are constraints.>

## Acceptance criteria

- Given <state>, when <action>, then <observable result>.
- Given <state>, when <action>, then <observable result>.
- Given <failure condition>, when <action>, then <what the user sees and who is notified>.

## Out of scope

- <Explicit exclusion.>

## Constraints

- Performance: <numbers, or "none known">
- Permissions: <who may do this, or "none known">
- Data: <migrations, retention, formats, or "none known">
- Compatibility: <what must keep working, or "none known">

## Affected code

- `<path>`: <why a developer opens it first>

## Assumptions

- <Each assumption the analyst made, marked "(assumption)". Empty is fine.>

## Open decisions

- <Question. Decides: <name>. Blocking: yes | no.>

## Instructions for the coding agent

1. Work on a branch named `intake/<issue-number>-<slug>` from the default branch.
2. Read the repository's `AGENTS.md` and follow its conventions; do not change unrelated code.
3. Implement the desired behavior and add or update tests so every acceptance criterion above fails before your change and passes after it.
4. Open a pull request whose description lists the acceptance criteria as a checklist, ticks each with the test that proves it, and links this issue.
5. If any "Open decisions" entry blocks you, stop and comment on this issue instead of guessing.
