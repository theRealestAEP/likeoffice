import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { createDocumentWindow, openDocumentDialog } from "./index";

function sendToFocused(action: string): (menuItem: unknown, win?: unknown) => void {
  return (_item, win) => {
    const w = win as Electron.BrowserWindow | undefined;
    w?.webContents.send("menu", action);
  };
}

export function buildMenu(): Menu {
  const isMac = process.platform === "darwin";
  const settingsItem: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: sendToFocused("settings"),
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "LikeOffice",
            submenu: [
              { role: "about" },
              { type: "separator" },
              settingsItem,
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Document",
          accelerator: "CmdOrCtrl+N",
          click: () => void createDocumentWindow(),
        },
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: () => void openDocumentDialog(),
        },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: sendToFocused("save") },
        {
          label: "Save As…",
          accelerator: "Shift+CmdOrCtrl+S",
          click: sendToFocused("save-as"),
        },
        { type: "separator" },
        { label: "Export as PDF…", click: sendToFocused("export-pdf") },
        { label: "Print…", accelerator: "CmdOrCtrl+P", click: sendToFocused("print") },
        { type: "separator" },
        ...(isMac ? [] : [settingsItem, { type: "separator" } as MenuItemConstructorOptions]),
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: sendToFocused("undo") },
        {
          label: "Redo",
          accelerator: "Shift+CmdOrCtrl+Z",
          click: sendToFocused("redo"),
        },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "AI Assistant",
          accelerator: "Shift+CmdOrCtrl+A",
          click: sendToFocused("toggle-ai"),
        },
        { type: "separator" },
        ...(app.isPackaged
          ? []
          : [
              { role: "reload" } satisfies MenuItemConstructorOptions,
              { role: "toggleDevTools" } satisfies MenuItemConstructorOptions,
              { type: "separator" } satisfies MenuItemConstructorOptions,
            ]),
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  return Menu.buildFromTemplate(template);
}
