# repo-tweeter

Automatically analyze any GitHub repository and generate a continuous Twitter/X thread about it — powered by GPT-4 and GitHub Actions.

## What it does

`repo-tweeter` walks through a target GitHub repository file by file, reads the source code, and uses OpenAI GPT-4 to generate educational tweet drafts. Each file produces 20 tweets:

- **10 beginner-friendly** — explain concepts simply, with analogies
- **10 senior-developer-focused** — discuss architecture, tradeoffs, and patterns

Every batch of 12 tweets also triggers a bonus **trending AI/ML tweet** for broader reach.

Tweets are delivered to your inbox as email drafts via Gmail, one per workflow run, so you stay in full control of what gets posted.

## How it works

```
GitHub Repo → GitHub API → File Queue → GPT-4 Analysis → Email Draft (Gmail)
                                ↑                               ↓
                           state.json ←─────── GitHub Actions ──┘
```

1. On each run, the script reads `state.json` to find its position in the file queue
2. It fetches the next file from the target repo via the GitHub API
3. GPT-4 generates 20 contextual tweets quoting real code from that file
4. One tweet draft is emailed to you via nodemailer + Gmail
5. `state.json` is committed back to the repo to save progress
6. GitHub Actions re-runs the workflow every 2 hours automatically

## Setup

### 1. Fork this repository

### 2. Set GitHub Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI API key (GPT-4 access required) |
| `GMAIL_APP_PASSWORD` | A Gmail [App Password](https://myaccount.google.com/apppasswords) (not your regular password) |
| `RECIPIENT_EMAIL` | The email address to receive tweet drafts |

### 3. Set GitHub Variables

| Variable | Description |
|---|---|
| `TARGET_REPO` | The GitHub repo to analyze, e.g. `owner/repo-name` |

### 4. Enable the workflow

Go to **Actions** and enable the workflow. It will run automatically every 2 hours, or you can trigger it manually with **Run workflow**.

## Configuration

The workflow schedule is defined in `.github/workflows/tweet.yml`:

```yaml
on:
  schedule:
    - cron: '0 */2 * * *'   # every 2 hours
  workflow_dispatch:          # or run manually
```

Adjust the cron expression to control delivery frequency.

## State tracking

Progress is saved in `state.json` at the repo root. It tracks:

- Current file index in the queue
- Full list of files to process
- Total tweets sent so far
- Target repository metadata

Delete or reset `state.json` to restart from the beginning of a new target repo.

## Dependencies

| Package | Purpose |
|---|---|
| `openai` ^4.0 | GPT-4 tweet generation |
| `nodemailer` ^6.9 | Email delivery via Gmail SMTP |

Install locally:

```bash
npm install
```

## Running locally

```bash
OPENAI_API_KEY=sk-... \
GMAIL_APP_PASSWORD=xxxx \
RECIPIENT_EMAIL=you@example.com \
TARGET_REPO=owner/repo-name \
node src/tweet.js
```

## File types handled

Binary and media files are automatically skipped (images, videos, compiled assets, etc.). Jupyter notebooks are parsed for readable cell content rather than raw JSON.

Files are prioritized so READMEs, configs, and key training scripts are processed first.

## License

MIT
