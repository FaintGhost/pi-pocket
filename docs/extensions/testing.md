# Testing

Test a module on a copy of Pi Pocket, never on the live one.

Copy the module into a test app's data folder and turn it on, as `test/docs-examples.test.ts` does: `openApp` with a scripted model (`test/helpers.ts`), the file in `<dataDir>/extensions/`, `app.setExtensionEnabled(owner, file, true)`, then a session whose scripted model calls the tool. Nothing reaches a real provider, and nothing touches the live data.

`test/extension-commands.test.ts` runs a module's commands as different people, across a restart and a reload.

For a drop-in, run the test from Pi Pocket's folder with the module copied in, or check it by hand: turn it on, ask Pi to use it in a session made for the purpose, and watch Menu → Extensions and the app's notices for errors.

For what a module adds to the app, `test/extension-web.test.ts` calls routes over HTTP as different people, and `test/extension-ui.test.ts` loads the app in a real Chromium and uses a module's rail button, page, menu row, and sheet. On a copy (`node test/serve.ts`), turn the module on, open the app, and keep the browser's console open.
