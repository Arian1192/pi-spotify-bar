# pi-spotify-bar

A small macOS-only [pi](https://pi.dev) extension that shows Spotify playback status in the footer.

## Features

- Current track, artist, and album
- Play / pause indicator
- Animated progress bar
- Volume readout
- Commands to refresh and control playback

## Requirements

- macOS
- Spotify installed and running
- macOS Automation permission for your terminal when prompted

## Installation

### Try it locally

From inside this folder:

```bash
pi -e .
```

### Install from git

```bash
pi install git:github.com/Arian1192/pi-spotify-bar
```

### Manual local install

Copy the whole folder to a location under `~/.pi/agent/extensions/`, for example:

- `~/.pi/agent/extensions/pi-spotify-bar/`

Pi will auto-discover the `index.ts` entry point.

## Commands

- `/spotify-test` — triggers the macOS permission prompt
- `/spotify-refresh` — refreshes the footer state
- `/spotify-toggle` — play / pause
- `/spotify-next` — next track
- `/spotify-prev` — previous track

## Behavior

- The footer refreshes automatically every few seconds.
- If Spotify is not running, the footer shows a neutral status.
- If automation permission is missing, pi will show a friendly error message.

## Publishing notes

This package is ready to publish as a pi package.

Before publishing, review these fields in `package.json`:

- `name` — the published package name
- `version` — bump before each release
- `description` — short public summary
- `author` — your display name or handle
- `repository.url` — your git repository URL
- `homepage` — your project homepage
- `bugs.url` — issue tracker URL

## License

MIT
