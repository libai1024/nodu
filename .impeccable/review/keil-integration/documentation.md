# Keil integration documentation outcome

Date: 2026-10-28

Status: complete for this ordinary extension. The [production contract](../../surfaces/keil-integration.md) and [ship review](review.md) describe the delivered File-menu and Project Settings surface. No new visual system, shared token, component primitive, raster asset, or global design-document revision is required.

## Evidence checked

- Read the Impeccable `reference/document.md` guidance, root `DESIGN.md`, current `.impeccable/design.json`, `PRODUCT.md`, the production surface contract, and the ship review.
- Opened [file-menu.png](file-menu.png), [settings-off.png](settings-off.png), [settings-on.png](settings-on.png), and [settings-compact.png](settings-compact.png) at original resolution. The first three show the 1600×900 desktop; the compact image contains a 1280×800 application viewport within a larger capture canvas. The setting and its explanation, with Save and Cancel, remain visible in both sizes.
- Read the added setting in `desktop/scope-extension/src/browser/nodu-project-dialogs.tsx` and the command/menu registration in `desktop/scope-extension/src/browser/nodu-embedded-contribution.ts`, including their working-tree diffs.
- Checked the reused rules in `desktop/scope-extension/style/embedded.css`; that stylesheet has no working-tree change. Checked the Windows gate and installation-derived `canOpen` value in `desktop/scope-extension/src/node/nodu-keil-project.ts`.

## Incumbent system reuse

| Surface | Existing treatment retained | Documentation consequence |
| --- | --- | --- |
| File → Keil 工程 | Theia submenu and menu actions, inherited workbench typography, surface, hover and selection treatment | Keep this placement in the surface contract; no new navigation primitive. |
| 自动维护 Keil 工程 | Native checkbox inside the existing project checkbox label, with the existing form spacing and focus rule | Record default-off and per-project persistence as feature behavior; no new checkbox token. |
| Explanatory group | Existing settings container, border and subdued explanation text, all using incumbent classes and theme variables | No new color, material, spacing or shape vocabulary. |
| Save / Cancel and errors | Existing Theia primary/secondary buttons and the existing alert markup/error class | No separate action or error visual system. |

The reviewed addition introduces no hardcoded palette, custom icon, display typography, decorative imagery, motion, or new stylesheet. Its visual identity remains the Nodu desktop workbench documented by the root design authority. Existing CSS supplies the form focus treatment; no focused-checkbox capture was supplied, so this is a source check rather than a visual certification of that state.

## Surface behavior retained

- File → Keil 工程 shows Generate before generation and Update afterward. Open is gated by a supported project and detected Keil installation; the installation lookup returns no result outside Windows. The supplied macOS menu capture correctly omits Open.
- Automatic maintenance is opt-in for each project. The checkbox initializes from `autoSync === true`; Save submits it, and Cancel only closes the dialog. The explanation retains the manual File-menu update path when automatic maintenance is off.
- No Keil action is added to recent-project surfaces in the reviewed menu registration. The earlier launcher demonstration remains historical and is not the production design authority.
- Quiet automatic success and preservation of user edits on conflict remain part of the production contract and the ship review's reported behavioral verification.

## Existing documentation drift, left unchanged

1. Root `DESIGN.md` says `.impeccable/design.json` records the v1 blue scheme. The current sidecar instead declares schema version 2, a brand v2 title and palette, and a 2026-10-28 generation time. That stale sentence predates this documentation pass; neither file was edited.
2. `PRODUCT.md` remains a 0.1.2-era product record and describes STM32 as future scope, while this reviewed production surface extends an existing STM32 workbench. The root design prose and sidecar also retain that older product-scope restriction. This is pre-existing product/version drift, not a Keil visual-system change. No broader platform support or hardware-verification claim is inferred or updated here.

These observations are scoped to the files needed for this extension, not a full global documentation/schema audit. The user's requested feature does not authorize a global rewrite.

## Completion and limits

Documentation is complete for the approved production direction, and no documentation blocker remains for this bounded extension. The global `DESIGN.md`, sidecar, `PRODUCT.md`, implementation, earlier prototype, and unrelated working-tree changes were preserved.

This pass independently inspected screenshots and source. It did not rerun behavior tests, launch Keil, compile on Windows, or flash hardware. Windows UI, light theme, focused checkbox, busy state, and error state are not visually certified by the supplied captures. Behavioral and Windows compilation evidence remains attributed to the implementation verification recorded in the ship review.
