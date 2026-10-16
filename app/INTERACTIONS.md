# Interaction conventions

The renderer remains plain JavaScript and CSS. These references informed the interaction patterns; no React dependency or third-party source was copied:

- [Radix animation](https://www.radix-ui.com/primitives/docs/guides/animation): explicit open/closed state, keeping a closing panel mounted until its exit animation finishes.
- [Radix tabs](https://www.radix-ui.com/primitives/docs/components/tabs): one active tab stop, arrow/Home/End navigation — now applied to the board titles.
- [shadcn/ui Sheet](https://ui.shadcn.com/docs/components/radix/sheet): directional entry/exit and restrained side-panel motion.

The main area is a set of boards. "全部课程" is one fixed board: the next deadline plus a 30-day, week-aligned calendar whose items are coloured per course (the same colour as the course dot in the sidebar). A specific course shows three core boards (作业 / 公告 / 课件), and the optional AI assistant contributes a fourth (课程结构分析) when enabled under Settings → Plugins. The AI plugin defaults to disabled. The overview has live, read-only previews (inert content, the whole board is clickable); stage mode shows one full-size board with the remaining boards as tilted live thumbnails on the left. Switching boards only changes layout classes; content nodes stay mounted and the move is a 200 ms FLIP transition (skipped under reduced motion). Escape returns from the stage to the overview; arrow keys move between the currently registered board titles. Disabling a plugin removes its board and returns an active removed board to overview.

Settings → Plugins distinguishes installation from activation. The installer supplies a bundled plugin, initially installed but unchecked. Uninstall removes the installed copy and its contributions while keeping course data, AI configuration and reports. It remains uninstalled after restarting. Reinstall restores the bundled copy without network access and leaves it unchecked. A plugin with a pending task refuses disabling or uninstalling; its current UI remains intact and the error is shown in settings. Per-plugin operations disable controls until the result arrives and restore keyboard focus afterwards.

Skin plugins use the same installation lifecycle and contribute renderer resources only. HKUST is the only skin installed by default; other skins appear in the appearance selector after installation. Removing the selected skin falls back to installed HKUST or the core's neutral appearance. Installing a skin does not overwrite the saved appearance choice.

The settings footer has one Save button for appearance, diagnostics and enabled plugin configuration. Cancel discards these drafts, including theme previews and AI provider profiles. AI connection tests and capability probes do not save drafts. Plugin install/uninstall/enable operations take effect immediately and are explicitly described as such; cancelling settings does not undo those completed operations. Save failures keep the dialog and draft fields available for retry. The settings panel scrolls independently so the title, tabs and footer remain visible.

Keep navigation nodes and assignment rows mounted when only their selected state changes. Repeated clicks on the current section/course should not redraw it. Announcement bodies stay mounted while folded, and are inert while closed. Reading body text must not toggle the announcement.

Use 120–180 ms transitions without scale/bounce effects on text. Respect reduced motion. Detail exits can be interrupted by another open action. Row heights stay consistent when the detail panel narrows the list, preventing scroll jumps.

Show file content immediately while local download status is checked; ignore outdated asynchronous responses after a course switch. Sync uses a fixed-width text button and a separate progress strip.

Run `node --test app/tests/sync.test.cjs app/tests/sync-progress.test.cjs` for sync checks. Run `app/node_modules/electron/dist/electron.exe app/tests/interaction-electron.cjs` for real-renderer interaction checks using synthetic data and no network calls. The latter exits with code 0 on success.
