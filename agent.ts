/**
 * /Users/mckaywrigley/Desktop/takeoff-ai/join-takeoff-example-repos/courses/levels-of-agents-course/agent-level-1/agent.ts
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { generateText } from "ai";
import bodyParser from "body-parser";
import { config } from "dotenv";
import express from "express";
import SmeeClient from "smee-client";

config({ path: ".env.local" });

/**
 * This is a Level 1 GitHub Agent that:
 * 1. Listens for new Pull Request events
 * 2. Analyzes the PR's contents (title, files, commits)
 * 3. Generates a summary using AI
 * 4. Posts the summary as a comment on the PR
 */

// ------------------------------------------------------------------
// 1) SETUP GITHUB & OPENAI CLIENTS
// ------------------------------------------------------------------

// Validate required GitHub App credentials
// These are needed to authenticate our app with GitHub
const APP_ID = process.env.GITHUB_APP_ID;
const PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY;
const INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;

if (!APP_ID || !PRIVATE_KEY || !INSTALLATION_ID) {
  throw new Error(
    `Missing required environment variables:
    APP_ID: ${!!APP_ID}
    PRIVATE_KEY: ${!!PRIVATE_KEY}
    INSTALLATION_ID: ${!!INSTALLATION_ID}`
  );
}

// Initialize GitHub client (Octokit) with our app's credentials
// This allows us to make authenticated API calls to GitHub
const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: APP_ID,
    privateKey: PRIVATE_KEY,
    installationId: INSTALLATION_ID
  }
});

// Initialize OpenAI client for generating summaries
// Uses AI-SDK for better token management and caching
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  compatibility: "strict"
});

// ------------------------------------------------------------------
// 2) HELPER FUNCTION TO SUMMARIZE USING OPENAI
// ------------------------------------------------------------------

/**
 * Calculates the cost of AI API usage based on token counts
 * - Cached tokens are cheaper ($1.50 per 1M tokens)
 * - Uncached tokens cost more ($3.00 per 1M tokens)
 * - Output tokens are most expensive ($12.00 per 1M tokens)
 */
async function calculateCosts(usage: any, experimental_providerMetadata: any) {
  const cachedTokens = (experimental_providerMetadata?.openai?.cachedPromptTokens ?? 0) as number;
  const uncachedTokens = (usage.promptTokens - cachedTokens) as number;

  const cachedInputCost = (cachedTokens / 1_000_000) * 1.5; // $1.50 per 1M cached tokens
  const uncachedInputCost = (uncachedTokens / 1_000_000) * 3.0; // $3.00 per 1M uncached tokens
  const outputCost = (usage.completionTokens / 1_000_000) * 12.0; // $12.00 per 1M output tokens
  const totalCost = cachedInputCost + uncachedInputCost + outputCost;

  return {
    cachedInputCost,
    uncachedInputCost,
    outputCost,
    totalCost
  };
}

/**
 * Generates an AI summary of a Pull Request
 * @param title - The PR title
 * @param fileNames - List of changed files
 * @param commitMessages - List of commit messages
 * @returns A concise summary paragraph
 */
async function summarizePullRequest(title: string, fileNames: string[], commitMessages: string[]): Promise<string> {
  // Construct a clear prompt for the AI model
  const prompt = `Summarize this pull request in a concise paragraph:

PR Title: ${title}
Changed Files: ${fileNames.join(", ") || "None"}
Commit Messages: 
- ${commitMessages.join("\n- ") || "No commit messages"}

Summary:`;

  // Generate the summary using OpenAI
  // o1-mini is optimized for shorter, focused responses
  const { text, usage, experimental_providerMetadata } = await generateText({
    model: openai("o1-mini"),
    prompt
  });

  // Calculate and log costs
  const costs = await calculateCosts(usage, experimental_providerMetadata);
  console.log("-- COSTS --");
  console.log(`Cached input cost: $${costs.cachedInputCost.toFixed(6)}`);
  console.log(`Uncached input cost: $${costs.uncachedInputCost.toFixed(6)}`);
  console.log(`Output cost: $${costs.outputCost.toFixed(6)}`);
  console.log(`Total cost: $${costs.totalCost.toFixed(6)}`);

  return text.trim();
}

// ------------------------------------------------------------------
// 3) WEBHOOK HANDLER
// ------------------------------------------------------------------

/**
 * Handles the 'pull_request.opened' webhook event
 * 1. Extracts PR details from the webhook payload
 * 2. Fetches additional PR data (files, commits)
 * 3. Generates and posts an AI summary comment
 */
async function handlePullRequestOpened(payload: any) {
  // Extract repository and PR information from the webhook payload
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.pull_request.number;
  const title = payload.pull_request.title;

  // Fetch the list of files changed in this PR
  const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pullNumber });
  const changedFileNames = filesRes.data.map((f) => f.filename);

  // Fetch all commit messages in this PR
  const commitsRes = await octokit.pulls.listCommits({ owner, repo, pull_number: pullNumber });
  const commitMessages = commitsRes.data.map((c) => c.commit.message);

  // Summarize
  const summary = await summarizePullRequest(title, changedFileNames, commitMessages);

  const botComment = `## 🤖 PR Summary Bot

${summary}`;

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: botComment
  });

  console.log(`Posted summary comment to PR #${pullNumber} in ${owner}/${repo}`);
}

// ------------------------------------------------------------------
// 4) EXPRESS SERVER SETUP
// ------------------------------------------------------------------
const app = express();
app.use(bodyParser.json());

// Configure Smee client if WEBHOOK_PROXY_URL is provided
const WEBHOOK_PROXY_URL = process.env.WEBHOOK_PROXY_URL;
if (WEBHOOK_PROXY_URL) {
  const smee = new SmeeClient({
    source: WEBHOOK_PROXY_URL,
    target: `http://localhost:${process.env.PORT || 3000}/webhook`,
    logger: console
  });

  smee.start();
  console.log("Smee client started");
}

// Test endpoint
app.get("/", (req, res) => {
  res.send("Hello World");
});

// Main webhook endpoint
// GitHub sends all webhook events to this URL
app.post("/webhook", async (req, res) => {
  try {
    // GitHub includes the event type in the headers
    const eventType = req.headers["x-github-event"];
    const payload = req.body;

    // We only care about new PRs (pull_request.opened events)
    if (eventType === "pull_request" && payload.action === "opened") {
      await handlePullRequestOpened(payload);
    }

    // Respond with 200 to indicate we processed the webhook
    res.status(200).send("OK");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ------------------------------------------------------------------
// 5) START THE SERVER
// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Level 1 Agent listening on port ${PORT}`);
});
