# Level 1 Agent – PR Summarizer

A **Level 1 AI Agent** that listens for new Pull Requests, summarizes them using OpenAI, and posts a comment on the PR.

## Setup

1. **Install Dependencies**

   ```bash
   npm install
   ```

2. **Environment Variables**
   - Copy `.env.example` to `.env.local`
   - Set `OPENAI_API_KEY` and `GITHUB_TOKEN`

## Run the Agent

```bash
npm run start
```

By default, this starts a webhook server at `http://localhost:3000`.

## Usage

### GitHub Webhook Setup

#### Local Testing with ngrok

1. Install ngrok: https://ngrok.com/
2. Start your server: `npm run start`
3. In a new terminal: `ngrok http 3000`
4. Copy the ngrok HTTPS URL (like `https://xxxx-xx-xx-xxx-xx.ngrok.io`)

#### Configure GitHub Webhook

1. In your repo's Settings > Webhooks:
   - Payload URL: Your ngrok URL + `/webhook` (e.g. `https://xxxx-xx-xx-xxx-xx.ngrok.io/webhook`)
   - Content type: `application/json`
   - Select "Pull requests" events
   - Enable SSL verification
   - Make sure webhook is Active

### Operation

1. Open a PR
2. The agent automatically:
   - Fetches PR data
   - Generates a summary via OpenAI
   - Comments on the PR

## How It Works

1. Express server listens for `pull_request.opened` events
2. Octokit fetches PR details (files, commits)
3. OpenAI generates a short summary
4. GitHub receives the summary as a PR comment
