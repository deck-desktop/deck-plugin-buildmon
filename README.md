# Builds

Watches the build id a backend reports and tells you when it changes.

Point it at one or more URLs that return a build id. It polls them, remembers what it last saw,
and the footer readout changes when a deployment lands - so you find out a redeploy finished
without refreshing anything by hand.

## What it exports

| Export | Where it renders |
|---|---|
| `Status` | the footer readout: which servers are being watched, and what changed |
| `commands` | palette entries for starting and stopping a watch |

## Checks

```sh
node plugins/buildmon/build.check.mjs
```

Covers decoding a build id and deciding whether it actually changed - the part that decides
whether you get told about a deploy at all.

## Build

```sh
node plugins/buildmon/build.mjs
```

See [../README.md](../README.md) for how the build and the shims work.

## Install

Copy `plugin.json` and `plugin.js` into `%APPDATA%\Deck\plugins\buildmon\` (`Deck-Dev` for a
debug build) and restart Deck.
