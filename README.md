
# A build tool for WebExtensions

This is not ready for public use yet, but in case you need to use it to build one of my WebExtensions, which expose this as `npm start`, here is the basic API.
The tool works hand in hand with the [web-ext-utils](https://github.com/NiklasGollenstede/web-ext-utils) framework and constructs the `manifest.json`, `files.json` (a list of all included files), and the entry point for all views.
The configuration comes from a `build-config.js` file in the extension root and the CLI arguments.

## Usage

```
  Usage: web-ext '<json_arg>'

  Where `<json_arg>` is an optional JSON5 object with the following optional options:
      TODO ...
```
