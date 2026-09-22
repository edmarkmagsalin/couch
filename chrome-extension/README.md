# Couch Chrome Extension

## Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `chrome-extension` folder from this repository.
5. Confirm that **Couch** appears in the extensions list.

## Use the extension locally

The extension connects to the development backend at `http://localhost:3000`. Start it from the repository root before testing:

```sh
pnpm install
pnpm backend
```

Open a supported site, such as YouTube, and click the Couch extension icon to show or hide the interface.

## Apply changes

After changing an extension file:

1. Return to `chrome://extensions`.
2. Click **Reload** on the Couch extension.
3. Refresh the supported site tab.

Chrome may also require the extension to be reloaded before changes to the service worker or manifest take effect.
