# Level 1 Agent – PR Summarizer

A **Level 1 AI Agent** that listens for new Pull Requests, summarizes them using OpenAI, and posts a comment as a bot.

## Setup

1. **Install Dependencies**

   ```bash
   npm install
   ```

2. **Set up Smee.io for Webhook**

   1. Go to [smee.io](https://smee.io)
   2. Click "Start a new channel"
   3. Copy the URL (looks like `https://smee.io/your-unique-url`)
   4. Add it to your `.env.local` file as `WEBHOOK_PROXY_URL`

3. **Create GitHub App**

   1. Go to GitHub Settings > Developer Settings > GitHub Apps > New GitHub App
   2. Fill in:
      - Name: `PR Summary Bot` (or your choice)
      - Homepage URL: `http://localhost:3000`
      - Webhook URL: Your Smee.io URL from step 2
      - Webhook Secret: (optional, but recommended)
      - Permissions:
        - Pull Requests: Read & Write
        - Contents: Read
        - Metadata: Read
      - Subscribe to events: Pull Request
   3. Create app and save:
      - App ID
      - Download private key (.pem file)
   4. Install app on your repository
   5. Get installation ID from URL: `https://github.com/settings/installations/[ID]`

4. **Environment Variables**
   - Copy `.env.example` to `.env.local`
   - Set:
     ```
     OPENAI_API_KEY=your-key
     GITHUB_APP_ID=your-app-id
     GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
     GITHUB_INSTALLATION_ID=your-installation-id
     ```
     Note: Convert .pem file contents to single line, replacing newlines with `\n`

## Usage

The bot will automatically:

1. Listen for new pull requests
2. Generate a summary using OpenAI
3. Post a comment as the bot account

## How It Works

1. Express server listens for `pull_request.opened` events
2. Octokit fetches PR details (files, commits)
3. OpenAI generates a short summary
4. GitHub receives the summary as a bot comment
