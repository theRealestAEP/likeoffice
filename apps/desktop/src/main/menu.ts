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

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: "appMenu" } satisfies MenuItemConstructorOptions]
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
        { label: "Print…", accelerator: "CmdOrCtrl+P", click: sendToFocused("print") },
        { type: "separator" },
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
