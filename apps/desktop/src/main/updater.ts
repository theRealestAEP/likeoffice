import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";

// Updates come from GitHub Releases (publish config in electron-builder.yml).
// Nothing is silent: the user confirms both the download and the install.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let checking = false;

/** Manual "Check for Updates…" flow. Only meaningful in the packaged app. */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged || checking) return;
  checking = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo.version;
    if (!version || !result.isUpdateAvailable) {
      dialog.showMessageBoxSync({
        type: "info",
        message: "You're up to date",
        detail: `LikeOffice ${app.getVersion()} is the latest version.`,
      });
      return;
    }
    const choice = dialog.showMessageBoxSync({
      type: "info",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `LikeOffice ${version} is available`,
      detail: `You have ${app.getVersion()}. Download the update now?`,
    });
    if (choice !== 0) return;
    await autoUpdater.downloadUpdate();
    const install = dialog.showMessageBoxSync({
      type: "info",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `LikeOffice ${version} is ready to install`,
      detail: "Restart the app to apply the update.",
    });
    if (install === 0) autoUpdater.quitAndInstall();
  } catch (err) {
    dialog.showMessageBoxSync({
      type: "error",
      message: "Update check failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    checking = false;
  }
}
