# Design

<!-- impeccable:design-schema 1 -->

## Direction contract (owner-pinned)

**THESIS.** DocuFlow is a modern, premium operational **workspace** — not a digital government form or a literal official document. It sits between a modern project-management platform and a premium financial-operations dashboard, while staying simpler and less data-dense than either. Calm authority, trust, precision, and excellent information hierarchy — expressed through contemporary SaaS patterns.

**OWN-WORLD.** A very light cool-blue app canvas (`#F5F7FF`) with crisp white surfaces raised by subtle, cool-toned shadows. **Royal blue** is the brand — it owns navigation and every action; green/amber/red stay strictly semantic. Modular cards and panels, soft contemporary radii, generous-but-efficient spacing. Geist Sans for the interface, Geist Mono for identifiers.

**STORY.** Staff open a calm workspace, scan a small operational summary, and work a Case in a strong master-detail view: Cases on the left, the selected Case's progress, Requirements grouped by Participant, and activity on the right.

**FIRST VIEWPORT.** Left icon rail · top bar (search, notifications, account) · page header (title, description, primary action) · small summary cards · master-detail workspace.

**FORM.** Modern SaaS operational workspace. Owner-pinned; references (project-management + financial-ops dashboards) inform depth, modularity, polish, navigation, and hierarchy only — never reproduced literally.

## Platform

web · light. Cool-blue canvas; dark mode deferred.

## Color

Royal blue is the brand; the semantic trio is reserved for state. Canonical values in `src/app/globals.css`.

| Token | Value | Use |
|---|---|---|
| Royal Blue 700 | `#243DBD` | pressed / strong |
| Royal Blue 600 | `#3151D3` | primary action |
| Royal Blue 500 | `#4667E8` | hover / active nav |
| Royal Blue 100 | `#DDE5FF` | tint fills |
| Royal Blue 50 | `#F1F4FF` | subtle fills, selected rows |
| App Background | `#F5F7FF` | canvas |
| Surface | `#FFFFFF` | cards, panels |
| Primary Text | `#172033` | |
| Secondary Text | `#667085` | |
| Border | `#E4E8F1` | hairlines, card edges |
| Success | `#1F9D69` | approved / complete |
| Warning | `#D99116` | awaiting |
| Error | `#D94B5B` | rejected |
| Info | `#4B73E8` | informational |

## Typography

- **Geist Sans** — all interface text. Confident and modern, not editorial or governmental.
- **Geist Mono** — identifiers, reference numbers, dates, tabular values.

## Shape & elevation

- Inputs 10–12px · Cards 14–16px · Primary panels 18–20px radius.
- Pills only for statuses and compact filters.
- Subtle **cool-toned** shadows separate white surfaces from the canvas.
- No glassmorphism, no heavy shadows, no soft blob-like cards.

## Layout

Workspace shell: left navigation / compact icon rail · top bar (search, notifications, account) · page header (title, description, primary action) · small operational summary cards · main workspace as list/detail or table/detail.

**Cases experience → master-detail:** left shows Cases (or Participants); right shows the selected Case's progress, Requirements, Participants, and activity. Requirements group **by Participant**.

## Visual personality

Modern · calm · premium · clear · capable · secure · approachable.
Never: bureaucratic · generic · government-portal · AI-generated shadcn dashboard · overly financial · overly playful · excessively dense.

## Differentiation

Identity comes from: royal-blue navigation and actions · progress-first Case visualization · strong master-detail compositions · participant-based Requirement grouping · carefully designed status states · large calm working surfaces · thoughtful empty and completion states.

## States (required everywhere)

hover · disabled · loading · error · empty · completion. State is never carried by color alone — pair with a label.
