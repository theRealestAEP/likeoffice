# Known issues

Problems that are real, understood, and NOT fixed here — with the evidence, so
the next person does not re-investigate them.

## #129 — Electron segfaults while the process exits, after a PDF export

**Status:** upstream (Electron 34.5.8). No app fix. Harmless to results and to
documents; it costs a crash report on the way out.

### What happens

Some test-launched Electron processes die with `SIGSEGV` instead of exiting 0.
The crash reports are in `~/Library/Logs/DiagnosticReports/Electron-*.ips`. The
suite still reports green, because the crash lands after the test's work is
finished and Playwright's `app.close()` only waits for the process to go away.

### The faulting instruction

The crash is a null dereference at the first instruction of
`v8::ObjectTemplate::NewInstance(v8::Local<v8::Context>)` — `ldr x8, [x1]`
with `x1 = 0`, an EMPTY context. Disassembling the caller inside
`Electron Framework` shows the sequence exactly:

```
bl   v8::Isolate::GetCurrentContext      ; returns an empty Local
mov  x1, x0
bl   v8::ObjectTemplate::NewInstance     ; -> ldr x8, [x1], x1 = 0
```

The caller first checks `ObjectTemplate::InternalFieldCount() == 2`, which is
`gin::WrappableBase::GetWrapperImpl` — the wrapper factory for Electron's
native objects. Its callers reference the strings `will-destroy`, `destroyed`,
`emit` and `../../electron/shell/browser/api/electron_api_web_contents.cc`.

So: Electron destroys a `WebContents`, emits its destroy event, and builds the
JS event object for it while NO V8 context is entered. gin does not check for
that, and the process dies. Nothing here is app code.

### It happens after the app has already exited

A probe on the main process's lifecycle events (`before-quit`, `will-quit`,
`quit`, `process.on("exit")`, plus per-window `closed` and per-webContents
`destroyed`) puts the crash 20–60 ms AFTER `process.on("exit")` fires. The
app's JS is gone by then; no application code can run at that point.

Every crashing process shows the same trace, with the first window's
`destroyed` event MISSING:

```
main-start ready wc1-loaded wc2-loaded win2-closed wc2-destroyed
win1-closed before-quit will-quit exit 0 quit          <- crash here
```

A surviving process with the same shape ends `… quit wc1-destroyed`: the same
event, delivered a moment later, lands safely. The crash is that delivery
racing the teardown of the context it needs.

### What triggers the ordering

Launches that open a SECOND `WebContents`, which in this app means one thing:
the hidden `BrowserWindow` that `document:export-pdf` creates for
`printToPDF` (`apps/desktop/src/main/index.ts`).

Measured over 133 instrumented app launches of the full suite:

| Launch shape | Launches | Crashes |
| --- | --- | --- |
| One window | 122 | 0 |
| Two windows (PDF export) | 11 | 2 |

Concentrating on the export alone, `npx playwright test e2e/export-pdf.spec.ts
--repeat-each=10` produced 7 crashes, all with the trace above.

The rate depends on machine load, as a race does: those 7 crashes came from a
run on a busy machine (that run took 9.4 min instead of 24 s). The same
command on an idle machine produced none. Any A/B here must hold the load
constant, and a fix must be measured in dozens of exports under load.

### What was ruled out, by experiment

- **Spellcheck / nspell.** Its dictionary loads lazily on IPC and appears in no
  crash. The spellcheck spec never crashed.
- **Startup.** All 20 crashes examined happened at teardown, after `exit`.
- **`app.dock.hide()`** (69a29b1). Crashes predate it, and 130 launches with
  and without it behaved alike.
- **`destroy()` racing an in-flight render.** 130 launches that destroy windows
  mid-load, plus 60 launches of a BARE Electron app (one window, no LikeOffice
  code), never crashed. Neither did 40 launches that create and destroy hidden
  windows and force `gc()`.
- **App code as the trigger.** There is none to run: the app has already
  exited. The PDF is written and the file handles are closed before this.

### Reproducing it

```sh
nice -n 19 npx playwright test e2e/export-pdf.spec.ts --repeat-each=10
ls -t ~/Library/Logs/DiagnosticReports | grep Electron | head
```

Roughly one launch in three that exports a PDF crashes on the way out.

### Candidates that were tried and are unproven

Closing the print window (`printWin.close()`) instead of destroying it gave 0
crashes in 20 exports — but the unchanged code gave 0 in the same conditions,
because the machine was idle. The change is therefore unproven and was NOT
kept. Measure it under load before believing it.

### If it ever needs fixing

The fix belongs upstream: gin should not build a wrapper without an entered
context. An app-side workaround would have to guarantee that no `WebContents`
outlives the JS environment, which the app cannot do — the quit is driven from
outside it (Playwright's `app.quit()`, or a user's ⌘Q), and the window is
already closed before `before-quit` runs. Do not add one speculatively.
