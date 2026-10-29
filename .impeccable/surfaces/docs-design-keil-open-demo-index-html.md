---
version: 1
slug: "docs-design-keil-open-demo-index-html"
primary_target: "docs/design/keil-open-demo/index.html"
related_targets: ["docs/design/keil-open-demo/demo.css","docs/design/keil-open-demo/demo.js"]
---

# Nodu project opener demo

Mode: Operate. A narrow interactive demonstration of the already agreed project-open flow, using the incumbent Nodu design system. No production integration, external application launch, compilation or flashing. All sample projects are explicitly demonstration data.

## Direction contract

THESIS: One project, two ways to open it. The open split button and a shared editable source demonstrate the whole mechanism without a conversion wizard.

OWN-WORLD: Inherit the Nodu dark workbench, cool gray surfaces, blue actions, compact system typography and restrained green success state. Light mode remains available for a bright desk environment.

STORY: Select a recent STM32 project, choose Nodu or Keil, let inline first-use preparation finish, edit the shared source, save and switch tools. Remember each project's last successful choice.

FIRST VIEWPORT: A compact demo heading above a desktop application frame. Recent project rows occupy the left two thirds and a source preview occupies the right third. Each project has one open split button. Demo scope and reset remain outside the application frame. On narrow screens, rows stack and the supplementary preview recedes.

FORM: Precisely specified local extension; no concept seed applies. Project list transitions to a clearly labeled editor preview. The single authored transition is inline preparation becoming an opened editor.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Constraints: No app/code changes outside this demo; no rewrite of global design artifacts. Persist preferences and sample edits only in browser storage. Preserve unsaved text across tool switches. Show a safe recovery for a simulated missing Keil environment. Existing PRODUCT.md platform/version facts predate this session and are not being repaired.
