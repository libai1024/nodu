---
version: 1
slug: "keil-integration"
primary_target: "desktop/scope-extension/src/browser/nodu-project-dialogs.tsx"
related_targets: ["desktop/scope-extension/src/browser/nodu-embedded-contribution.ts", "desktop/scope-extension/src/browser/nodu-embedded-model.ts"]
---

# Keil project maintenance

Mode: Operate. A narrow extension of the existing desktop IDE. The user explicitly chose the File menu and a project setting, and excluded a recent-project entry. This production flow supersedes the earlier launcher demo as the implementation direction; that demo remains a historical exploration.

## Direction contract

THESIS: Let an existing STM32 project work with Keil through a familiar menu command, with maintenance available as an opt-in preference.

OWN-WORLD: Preserve the current Nodu desktop menus, dark/light theme tokens, project form, native checkbox, focus outline, and blue Save action. No new visual system or custom icon is needed.

STORY: Open a supported STM32 project. File → Keil 工程 offers generation or update. Windows users with Keil installed also get an open action. Project settings can enable automatic maintenance for the open project.

FIRST VIEWPORT: The editor remains the primary work area. The menu opens on demand. The existing project settings dialog gains one checkbox and one short explanation. Recent-project surfaces remain unchanged.

FORM: Code-led extension. Reuse existing form spacing and the existing settings explanation container. Initial state is unchecked. Save persists the choice; Cancel does not. No success popup for automatic maintenance. Conflicts produce a visible warning and leave user edits intact.

FINISH: Verify the real app at its normal desktop viewport and a smaller desktop window, including menu, default-off, saved-on, and error behavior. Desktop is the shipping target; mobile layout is outside this IDE feature's scope. Review and documentation must use the production interface, not the earlier demonstration.

No new shared tokens or raster assets. Existing PRODUCT.md/platform drift is outside this request.

## Documentation outcome

Complete, 2026-10-28. Production captures and implementation confirm reuse of the incumbent menu, project form, native checkbox, theme variables, and Save/Cancel controls. No global design-system changes are needed. Checked evidence, inherited styling, pre-existing documentation drift, and verification limits are recorded in [the documentation outcome](../review/keil-integration/documentation.md).
