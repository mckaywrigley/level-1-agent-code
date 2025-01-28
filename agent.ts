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

config({ path: ".env.local" });

/**
 * For a Level 1 Agent:
 * 1. Listen to "pull_request" opened events.
 * 2. Fetch PR data.
 * 3. Summarize with OpenAI.
 * 4. Post summary as a comment.
 */

// ------------------------------------------------------------------
// 1) SETUP GITHUB & OPENAI CLIENTS
// ------------------------------------------------------------------

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

// Initialize Octokit with App authentication
const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: APP_ID,
    privateKey: PRIVATE_KEY,
    installationId: INSTALLATION_ID
  }
});

// AI-SDK client for OpenAI
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY, // or use your custom approach
  compatibility: "strict"
});

// ------------------------------------------------------------------
// 2) HELPER FUNCTION TO SUMMARIZE USING OPENAI
// ------------------------------------------------------------------

// Add this helper function before the summarizePullRequest function
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

// Modify the summarizePullRequest function to include cost logging
async function summarizePullRequest(title: string, fileNames: string[], commitMessages: string[]): Promise<string> {
  // Craft a simple prompt
  const prompt = `Summarize this pull request in a concise paragraph:

PR Title: ${title}
Changed Files: ${fileNames.join(", ") || "None"}
Commit Messages: 
- ${commitMessages.join("\n- ") || "No commit messages"}

Summary:`; // We'll expect the model to fill in the summary after "Summary:"

  // Call AI SDK
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
async function handlePullRequestOpened(payload: any) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.pull_request.number;
  const title = payload.pull_request.title;

  // Optional: fetch changed files
  const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pullNumber });
  const changedFileNames = filesRes.data.map((f) => f.filename);

  // Optional: fetch commit messages
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

// GitHub will send POST requests to /webhook
app.post("/webhook", async (req, res) => {
  try {
    const eventType = req.headers["x-github-event"];
    const payload = req.body;

    // Only handle pull_request "opened"
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
