import { test, expect } from "@playwright/test";
import { formatAccelerator, menuShortcutSections } from "../apps/desktop/src/main/shortcuts";

/**
 * Unit tests for the accelerator formatter and the menu walk. Both are pure,
 * so they run here without launching the app; the e2e spec asserts the real
 * menu's keys reach the real shortcuts sheet.
 */

test("macOS writes the modifier symbols the shortcuts sheet uses", () => {
  expect(formatAccelerator("CmdOrCtrl+F", true)).toBe("⌘F");
  expect(formatAccelerator("Shift+CmdOrCtrl+S", true)).toBe("⇧⌘S");
  expect(formatAccelerator("CmdOrCtrl+Alt+1", true)).toBe("⌥⌘1");
  expect(formatAccelerator("Alt+CmdOrCtrl+=", true)).toBe("⌥⌘=");
  expect(formatAccelerator("Control+Shift+K", true)).toBe("⌃⇧K");
});

test("elsewhere writes the spelled-out modifiers, same order as the engine", () => {
  expect(formatAccelerator("CmdOrCtrl+F", false)).toBe("Ctrl+F");
  expect(formatAccelerator("Shift+CmdOrCtrl+S", false)).toBe("Ctrl+Shift+S");
  expect(formatAccelerator("CmdOrCtrl+Alt+1", false)).toBe("Ctrl+Alt+1");
});

test("keys print as a sheet writes them: letters upper-cased, Return named Enter", () => {
  expect(formatAccelerator("CmdOrCtrl+b", true)).toBe("⌘B");
  expect(formatAccelerator("CmdOrCtrl+Return", true)).toBe("⌘Enter");
  expect(formatAccelerator("CmdOrCtrl+Enter", true)).toBe("⌘Enter");
  expect(formatAccelerator("CmdOrCtrl+,", true)).toBe("⌘,");
});

test("the walk groups accelerators by top-level menu and reaches nested submenus", () => {
  const sections = menuShortcutSections(
    {
      items: [
        {
          label: "Format",
          submenu: {
            items: [
              { label: "Bold", accelerator: "CmdOrCtrl+B" },
              { label: "Clear Formatting" }, // no accelerator: the engine owns ⌘\
              {
                label: "Styles",
                submenu: { items: [{ label: "Heading 1", accelerator: "CmdOrCtrl+Alt+1" }] },
              },
            ],
          },
        },
        // Nothing bound: the sheet gets no empty section.
        { label: "Help", submenu: { items: [{ label: "About" }] } },
      ],
    },
    true,
  );

  expect(sections).toEqual([
    {
      title: "Format menu",
      items: [
        { label: "Bold", keys: "⌘B" },
        { label: "Heading 1", keys: "⌥⌘1" },
      ],
    },
  ]);
});

test("no menu means no host shortcuts", () => {
  expect(menuShortcutSections(null, true)).toEqual([]);
});
