# Preview verification

Verified using the Codex in-app browser at 1440 × 1120 and 390 × 844.

- Website loads with no JavaScript console errors in the tested initial view.
- Code workspace run changes to stop and updates demo logs; stop retains a frame.
- LAB lower bound changed from 25 to 26, applying parameters updated the preview source.
- Device deployment reached 100% and explicitly states that no real device was written.
- Startup flow progresses through selection, overwrite review, and an explicitly simulated installation result.
- Command search filters page and workspace commands by the Chinese keyword 视觉.
- Mobile navigation opens and selects pages, then closes after selection.
- Component density and switches respond to interaction.
- Foundation and components layouts have no document overflow at 390 px; IDE preview is intentionally horizontally scrollable at small widths.
- Core workspace captures saved for image generation after website implementation.

One mechanical scan found undersized auxiliary text, a source-less dormant lightbox image, layout transitions and decorative shadow concerns. These were corrected in one batch. Functional text uses an 11 px floor. The preview has no real hardware integration and was not tested as a native Windows or macOS application.

## Targeted review-fix verification

- Keyboard Enter on Run leaves focus on the replacement Stop control (observed activeElement text: 停止运行).
- Deployed only main.py after unchecking camera.py and thresholds.py; final rows show main.py 演示完成 and both others 未选择.
- Startup checkbox remains checked through deployment and mode changes.
- Setting brightness lower bound to 100 and switching to replay shows 0 targets, no target cards, and the explicit empty-result message.
- The core-image lightbox opens and closes after gallery generation. No JavaScript console errors in this final interaction pass.
- Raster provenance scan: 4 rasters, 0 missing.
