import { createOpenAI } from "@ai-sdk/openai";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { generateText } from "ai";
import bodyParser from "body-parser";
import { config } from "dotenv";
import express from "express";
import SmeeClient from "smee-client";
import { parseStringPromise } from "xml2js";

config({ path: ".env.local" });

/**
 * This is a Level 1 Coding Agent that:
 * 1. Listens for new Pull Request events
 * 2. Analyzes the PR's contents (title, files, commits)
 * 3. Generates a summary using AI
 * 4. Posts the summary as a comment on the PR
 */

// ------------------------------------------------------------------
// SECTION 1: TYPE DEFINITIONS
// These help TypeScript understand our data structures
// ------------------------------------------------------------------

// Represents changes made to a file in a PR
interface FileChange {
  filename: string; // Path to the changed file
  patch: string; // The actual changes in diff format
  status: string; // Status of the change (added, modified, removed)
  additions: number; // Number of lines added
  deletions: number; // Number of lines deleted
  content?: string; // Current content of the file (if available)
}

// Represents a comment to be made on specific line of code
interface ReviewComment {
  path: string; // File path where comment should be made
  line: number; // Line number for the comment
  body: string; // Content of the comment
}

// Structure for our AI's analysis of the code
interface CodeAnalysis {
  summary: string; // Overall summary of the changes
  fileAnalyses: {
    // Analysis for each changed file
    path: string;
    analysis: string;
    suggestedComments: ReviewComment[];
  }[];
  overallSuggestions: string[]; // List of improvement suggestions
}

// Represents a summary of a single file in the PR
interface FileSummary {
  path: string;
  summary: string;
}

// Represents the complete PR summary structure
interface PRSummary {
  overview: string;
  files: FileSummary[];
}

// ------------------------------------------------------------------
// SECTION 2: AUTHENTICATION & CLIENT SETUP
// Setting up our connections to GitHub and OpenAI
// ------------------------------------------------------------------

// Validate required GitHub App credentials
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

// Initialize GitHub client with our app's credentials
const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: APP_ID,
    privateKey: PRIVATE_KEY,
    installationId: INSTALLATION_ID
  }
});

// Initialize OpenAI client for generating summaries
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  compatibility: "strict"
});

// ------------------------------------------------------------------
// SECTION 3: CORE AI FUNCTIONS
// Functions for generating and parsing AI responses
// ------------------------------------------------------------------

/**
 * Parses the XML response from our AI model into a structured format
 * This converts the AI's XML output into a TypeScript object we can use
 */
async function parseModelResponse(xmlResponse: string): Promise<PRSummary> {
  const parsed = await parseStringPromise(xmlResponse);
  return {
    overview: parsed.response.overview[0],
    files: parsed.response.files[0].file.map((file: any) => ({
      path: file.path[0],
      summary: file.summary[0]
    }))
  };
}

/**
 * Generates a summary of the pull request using AI
 * This is where we construct the prompt and get the AI's analysis
 */
async function summarizePullRequest(title: string, fileNames: string[], commitMessages: string[]): Promise<string> {
  // Construct prompt for the AI model
  const prompt = `Analyze this pull request and provide a summary in the following XML format:
<response>
  <overview>
    Provide a high-level summary of the entire PR, including its main purpose and key changes.
  </overview>
  <files>
    ${fileNames
      .map(
        (file) => `<file>
      <path>${file}</path>
      <summary>Summarize the changes in this file</summary>
    </file>`
      )
      .join("\n    ")}
  </files>
</response>

Pull Request Details:
Title: ${title}
Files Changed: ${fileNames.join(", ")}
Commit Messages: 
${commitMessages.map((msg) => `- ${msg}`).join("\n")}`;

  // Generate the summary using OpenAI
  const { text, usage, experimental_providerMetadata } = await generateText({
    model: openai("o1-mini"),
    prompt
  });

  // Extract XML from response
  const xmlStart = text.indexOf("<response>");
  const xmlEnd = text.indexOf("</response>") + "</response>".length;
  const xmlResponse = text.slice(xmlStart, xmlEnd);

  // Parse the XML response
  const summary = await parseModelResponse(xmlResponse);

  // Format the summary in Markdown
  const markdownSummary = `## 🔍 Pull Request Overview

${summary.overview}

## 📝 Changed Files

${summary.files
  .map(
    (file) => `### \`${file.path}\`
${file.summary}`
  )
  .join("\n\n")}

---
*Generated by PR Summary Bot*`;

  // Calculate and log costs
  const costs = await calculateCosts(usage, experimental_providerMetadata);
  console.log("-- COSTS --");
  console.log(`Cached input cost: $${costs.cachedInputCost.toFixed(6)}`);
  console.log(`Uncached input cost: $${costs.uncachedInputCost.toFixed(6)}`);
  console.log(`Output cost: $${costs.outputCost.toFixed(6)}`);
  console.log(`Total cost: $${costs.totalCost.toFixed(6)}`);

  return markdownSummary;
}

/**
 * Calculates the cost of AI API usage for monitoring purposes
 * Helps track different types of token usage and their associated costs
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

// ------------------------------------------------------------------
// SECTION 4: GITHUB INTERACTION FUNCTIONS
// Functions for interacting with GitHub's API
// ------------------------------------------------------------------

/**
 * Fetches the content of a specific file from GitHub
 * Used to get the current state of files for analysis
 */
async function getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref
  });

  // GitHub returns content as base64
  if ("content" in response.data) {
    return Buffer.from(response.data.content, "base64").toString();
  }
  throw new Error(`Could not get content for ${path}`);
}

/**
 * Uses AI to analyze code changes and generate review feedback
 */
async function analyzeCode(title: string, changedFiles: FileChange[], commitMessages: string[], baseRef: string, headRef: string): Promise<CodeAnalysis> {
  const prompt = `You are an expert code reviewer. Analyze these pull request changes and provide detailed feedback:

Context:
PR Title: ${title}
Commit Messages: 
${commitMessages.map((msg) => `- ${msg}`).join("\n")}

Changed Files:
${changedFiles
  .map(
    (file) => `
File: ${file.filename}
Status: ${file.status}
Diff:
${file.patch}

Current Content:
${file.content || "N/A"}
`
  )
  .join("\n---\n")}

Provide your review in the following XML format:
<review>
  <summary>High-level overview of changes</summary>
  <fileAnalyses>
    <file>
      <path>file path</path>
      <analysis>Detailed analysis of changes</analysis>
      <suggestedComments>
        <comment>
          <line>line_number</line>
          <body>Specific comment or suggestion</body>
        </comment>
      </suggestedComments>
    </file>
  </fileAnalyses>
  <overallSuggestions>
    <suggestion>First suggestion for improvement</suggestion>
    <suggestion>Second suggestion for improvement</suggestion>
  </overallSuggestions>
</review>`;

  const { text } = await generateText({
    model: openai("o1-mini"),
    prompt
  });

  // Extract XML from response
  const xmlStart = text.indexOf("<review>");
  const xmlEnd = text.indexOf("</review>") + "</review>".length;
  const xmlResponse = text.slice(xmlStart, xmlEnd);

  // Parse the XML response
  const parsed = await parseStringPromise(xmlResponse);

  // Convert the parsed XML to our CodeAnalysis type
  return {
    summary: parsed.review.summary[0],
    fileAnalyses: parsed.review.fileAnalyses[0].file.map((file: any) => ({
      path: file.path[0],
      analysis: file.analysis[0],
      suggestedComments: file.suggestedComments[0].comment.map((comment: any) => ({
        line: parseInt(comment.line[0]),
        body: comment.body[0]
      }))
    })),
    overallSuggestions: parsed.review.overallSuggestions[0].suggestion
  };
}

/**
 * Submits the AI-generated review to the PR
 */
async function submitReview(owner: string, repo: string, pullNumber: number, analysis: CodeAnalysis): Promise<void> {
  // Create review comments
  const comments = analysis.fileAnalyses.flatMap((fileAnalysis) =>
    fileAnalysis.suggestedComments.map((comment) => ({
      path: fileAnalysis.path,
      line: comment.line,
      body: comment.body
    }))
  );

  // Submit the review with inline comments
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    event: "COMMENT",
    comments,
    body: `# Code Review Summary

${analysis.summary}

${analysis.fileAnalyses
  .map(
    (file) => `
## ${file.path}
${file.analysis}
`
  )
  .join("\n")}

## Overall Suggestions
${analysis.overallSuggestions.map((suggestion) => `- ${suggestion}`).join("\n")}

---
*Generated by PR Review Bot*`
  });
}

/**
 * Handles new pull request events
 * This is our main webhook handler that coordinates the entire review process
 */
async function handlePullRequestOpened(payload: any) {
  // Extract repository and PR information from the webhook payload
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.pull_request.number;
  const title = payload.pull_request.title;
  const baseRef = payload.pull_request.base.sha;
  const headRef = payload.pull_request.head.sha;

  // Fetch files with their patches
  const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pullNumber });
  const changedFiles: FileChange[] = await Promise.all(
    filesRes.data.map(async (file) => ({
      filename: file.filename,
      patch: file.patch,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      content: await getFileContent(owner, repo, file.filename, headRef).catch(() => undefined)
    }))
  );

  // Fetch commit messages
  const commitsRes = await octokit.pulls.listCommits({ owner, repo, pull_number: pullNumber });
  const commitMessages = commitsRes.data.map((c) => c.commit.message);

  // Analyze the changes
  const analysis = await analyzeCode(title, changedFiles, commitMessages, baseRef, headRef);

  // Submit the review
  await submitReview(owner, repo, pullNumber, analysis);

  console.log(`Submitted code review for PR #${pullNumber} in ${owner}/${repo}`);
}

// ------------------------------------------------------------------
// SECTION 5: EXPRESS SERVER SETUP
// Setting up our web server to receive webhook events
// ------------------------------------------------------------------

const app = express();
app.use(bodyParser.json());

// Configure webhook proxy if URL is provided
const WEBHOOK_PROXY_URL = process.env.WEBHOOK_PROXY_URL;
if (WEBHOOK_PROXY_URL) {
  const smee = new SmeeClient({
    source: WEBHOOK_PROXY_URL,
    target: `http://localhost:${process.env.PORT || 3000}/webhook`,
    logger: console
  });

  smee.start();
  console.log("Webhook proxy client started");
}

// Health check endpoint
app.get("/", (req, res) => {
  res.send("PR Review Bot is running");
});

// Webhook endpoint - receives GitHub events
app.post("/webhook", async (req, res) => {
  try {
    const eventType = req.headers["x-github-event"];
    const payload = req.body;

    // Only process new PR events
    if (eventType === "pull_request" && payload.action === "opened") {
      await handlePullRequestOpened(payload);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PR Review Bot listening on port ${PORT}`);
});
