/**
 * /Users/mckaywrigley/Desktop/takeoff-ai/join-takeoff-example-repos/courses/levels-of-agents-course/agent-level-1/agent.ts
 */

import { createOpenAI } from "@ai-sdk/openai";
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

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  throw new Error("Missing GITHUB_TOKEN in environment variables");
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in environment variables");
}

// Octokit client for GitHub
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// AI-SDK client for OpenAI
const openai = createOpenAI({
  apiKey: OPENAI_API_KEY, // or use your custom approach
  compatibility: "strict"
});

// ------------------------------------------------------------------
// 2) HELPER FUNCTION TO SUMMARIZE USING OPENAI
// ------------------------------------------------------------------
async function summarizePullRequest(title: string, fileNames: string[], commitMessages: string[]): Promise<string> {
  // Craft a simple prompt
  const prompt = `Summarize this pull request in a concise paragraph:

PR Title: ${title}
Changed Files: ${fileNames.join(", ") || "None"}
Commit Messages: 
- ${commitMessages.join("\n- ") || "No commit messages"}

Summary:`; // We'll expect the model to fill in the summary after "Summary:"

  // Call AI SDK
  const { text } = await generateText({
    model: openai("o1-mini"),
    prompt
  });

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

  // Post the comment to the PR
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: summary
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
