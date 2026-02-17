---
name: google-auth
description: Authorize a Google account using GOG CLI with manual (headless) OAuth flow. Use when the user says "authorize Google" and provides an email address.
---

# Google Account Authorization

Authorize a Google account via GOG CLI's manual OAuth flow, allowing headless authentication without a local browser.

## Flow

When the user says "authorize Google <email>":

1. **Ask for email** if not provided in the prompt
2. **Run the auth command** in the background:
   ```bash
   gog auth add <email> --manual
   ```
3. **Extract the authorization URL** from the command output and present it to the user
4. **Wait for the user** to visit the URL on their own machine, complete Google consent, and paste the authorization code back
5. **Feed the code** into the running process to complete authentication

## Prerequisites

- `gog` CLI installed and available on PATH
- Client secrets registered via `gog auth credentials <path/to/client_secret.json>`

## Example

User: `authorize Google alice@example.com`

Agent:
1. Runs `gog auth add alice@example.com --manual` in background
2. Reads output, finds URL like `https://accounts.google.com/o/oauth2/auth?...`
3. Returns URL to user
4. User pastes back auth code
5. Agent writes code to the process stdin to complete auth

## Troubleshooting

- **"client_secret not found"**: Run `gog auth credentials ~/path/to/client_secret.json` first
- **Code rejected**: The authorization code is single-use and expires quickly — retry the full flow
- **Timeout**: The background process may time out waiting for input — restart and paste the code promptly
