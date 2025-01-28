import { createOpenAI } from "@ai-sdk/openai";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { generateText } from "ai";
import bodyParser from "body-parser";
import { config } from "dotenv";
import express from "express";
import SmeeClient from "smee-client";
import { parseStringPromise } from "xml2js";

// Load environment variables from .env.local file.
config({ path: ".env.local" });

// This interface defines the data structure for each file that was changed in the pull request.
interface FileChange {
  filename: string; // Name of the file (e.g., "src/index.js")
  patch: string; // The diff changes (the lines that were added/removed)
  status: string; // The status of the file (modified, added, removed, etc.)
  additions: number; // Number of lines added
  deletions: number; // Number of lines deleted
  content?: string; // The actual current content of the file (Base64-decoded)
}

// This interface defines the shape of our AI-generated code analysis results.
interface CodeAnalysis {
  summary: string; // A short summary of the pull request changes
  fileAnalyses: {
    path: string; // The path to the file being discussed
    analysis: string; // The AI's analysis for that file
  }[];
  overallSuggestions: string[]; // High-level recommendations or suggestions
}

// Retrieve required environment variables. These are specific to the GitHub App and must be set.
const APP_ID = process.env.GITHUB_APP_ID;
const PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY;
const INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID;

// Simple check to ensure that all required environment variables are present.
if (!APP_ID || !PRIVATE_KEY || !INSTALLATION_ID) {
  throw new Error(
    `Missing required environment variables:
    APP_ID: ${!!APP_ID}
    PRIVATE_KEY: ${!!PRIVATE_KEY}
    INSTALLATION_ID: ${!!INSTALLATION_ID}`
  );
}

// We also need the OpenAI API key to use the language model.
if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY environment variable.");
}

// This is our Octokit instance, which we'll use to interact with GitHub. It uses our GitHub App's credentials.
const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: APP_ID,
    privateKey: PRIVATE_KEY,
    installationId: INSTALLATION_ID
  }
});

// This is our OpenAI instance, which we'll use for the AI text generation.
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  compatibility: "strict"
});

/**
 * Retrieves the content of a file from a GitHub repository at a specific reference (e.g., commit SHA).
 * If the file doesn't exist or can't be retrieved, returns undefined.
 */
async function getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path, ref });
    // The response might contain various data structures depending on the type of the file or folder.
    if ("content" in response.data && typeof response.data.content === "string") {
      // Decode the file content from Base64 to a readable string.
      return Buffer.from(response.data.content, "base64").toString();
    }
    return undefined;
  } catch (error: any) {
    if (error.status === 404) {
      // If the file wasn't found at that reference, log it out and return undefined.
      console.log(`File ${path} not found at ref ${ref}`);
      return undefined;
    }
    // If it's another error, rethrow it.
    throw error;
  }
}

/**
 * Parses an XML string that we expect to follow a <review> ... </review> format into a CodeAnalysis object.
 * If parsing fails or required fields are missing, we return a fallback structure with minimal info.
 */
async function parseReviewXml(xmlText: string): Promise<CodeAnalysis> {
  try {
    // We find where the <review> tag starts and ends to parse just that section.
    const xmlStart = xmlText.indexOf("<review>");
    const xmlEnd = xmlText.indexOf("</review>") + "</review>".length;

    // If we can't find the tags, we provide a fallback message.
    if (xmlStart === -1 || xmlEnd === -1) {
      console.warn("Could not locate <review> tags in the AI response. Returning fallback.");
      return {
        summary: "AI analysis could not parse the response from the model.",
        fileAnalyses: [],
        overallSuggestions: []
      };
    }

    // Extract the portion of the string that contains the review XML.
    const xmlResponse = xmlText.slice(xmlStart, xmlEnd);

    // We use the xml2js library to parse the XML into a JavaScript object.
    const parsed = await parseStringPromise(xmlResponse);

    // Check if the parsed structure has the fields we need.
    if (!parsed.review || !parsed.review.summary || !parsed.review.fileAnalyses || !parsed.review.overallSuggestions) {
      console.warn("Parsed XML is missing required fields. Returning fallback.");
      return {
        summary: "AI analysis returned incomplete or invalid XML structure.",
        fileAnalyses: [],
        overallSuggestions: []
      };
    }

    // Transform the parsed data into our CodeAnalysis interface shape.
    return {
      summary: parsed.review.summary[0] ?? "",
      fileAnalyses: Array.isArray(parsed.review.fileAnalyses[0].file)
        ? parsed.review.fileAnalyses[0].file.map((file: any) => ({
            path: file.path?.[0] ?? "Unknown file",
            analysis: file.analysis?.[0] ?? ""
          }))
        : [],
      overallSuggestions: Array.isArray(parsed.review.overallSuggestions[0].suggestion) ? parsed.review.overallSuggestions[0].suggestion.map((s: any) => s || "") : []
    };
  } catch (err) {
    // In case of any error (e.g., malformed XML), log it and provide fallback data.
    console.error("Error parsing AI-generated XML:", err);
    return {
      summary: "We were unable to fully parse the AI-provided code analysis.",
      fileAnalyses: [],
      overallSuggestions: []
    };
  }
}

/**
 * Sends a request to our AI model with a prompt summarizing the pull request details, changed files,
 * and commit messages. The model then returns an XML-formatted review, which we parse into a CodeAnalysis object.
 */
async function analyzeCode(title: string, changedFiles: FileChange[], commitMessages: string[]): Promise<CodeAnalysis> {
  // We build a prompt that asks the AI to return an XML-formatted code review for the provided changes.
  const prompt = `You are an expert code reviewer. Analyze these pull request changes and provide detailed feedback.
Write your analysis in clear, concise paragraphs. Do not use code blocks for regular text.
Format suggestions as single-line bullet points.

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
  <summary>Write a clear, concise paragraph summarizing the changes</summary>
  <fileAnalyses>
    <file>
      <path>file path</path>
      <analysis>Write analysis as regular paragraphs, not code blocks</analysis>
    </file>
  </fileAnalyses>
  <overallSuggestions>
    <suggestion>Write each suggestion as a single line</suggestion>
  </overallSuggestions>
</review>;`;

  try {
    // Generate text using our OpenAI instance with the specified model (o1-mini in this example).
    const { text } = await generateText({
      model: openai("o1"),
      prompt
    });

    // Parse the text the AI returned to extract the structured review in XML.
    return await parseReviewXml(text);
  } catch (error) {
    // If something goes wrong (AI call fails or parsing fails), return a fallback response.
    console.error("Error generating or parsing AI analysis:", error);
    return {
      summary: "We were unable to analyze the code due to an internal error.",
      fileAnalyses: [],
      overallSuggestions: []
    };
  }
}

/**
 * Posts a simple "placeholder" comment on the GitHub pull request, letting the user know we're analyzing the code.
 * Returns the comment ID so we can update it later once the analysis is complete.
 */
async function postPlaceholderComment(owner: string, repo: string, pullNumber: number): Promise<number> {
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: "PR Review Bot is analyzing your changes... Please wait."
  });
  return data.id;
}

/**
 * Updates the placeholder comment with the final AI-generated review and suggestions.
 */
async function updateCommentWithReview(owner: string, repo: string, commentId: number, analysis: CodeAnalysis) {
  // We'll format the AI's analysis into a markdown comment.
  const finalReviewBody = `# Pull Request Review

${analysis.summary.trim()}

${analysis.fileAnalyses
  .map(
    (file) => `## ${file.path}
${file.analysis
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .join("\n")}`
  )
  .join("\n\n")}

## Suggestions for Improvement
${analysis.overallSuggestions.map((suggestion) => `• ${suggestion.trim()}`).join("\n")}

---
*Generated by PR Review Bot*`;

  // Use GitHub's API to update the existing comment with our final review.
  await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: finalReviewBody
  });
}

/**
 * Main handler for the "pull_request opened" event. Gathers info about the PR, calls AI for analysis,
 * and updates the PR with the results.
 */
async function handlePullRequestOpened(payload: any) {
  // The payload object from GitHub contains info like repository owner, repo name, PR number, etc.
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.pull_request.number;
  const title = payload.pull_request.title;
  const headRef = payload.pull_request.head.sha;

  try {
    // Post a placeholder comment on the PR so the user knows the bot is working.
    const placeholderCommentId = await postPlaceholderComment(owner, repo, pullNumber);

    // List the changed files in the PR.
    const filesRes = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber
    });

    // For each file, retrieve content if it isn't removed. Then build the FileChange structure.
    const changedFiles: FileChange[] = await Promise.all(
      filesRes.data.map(async (file) => {
        let content: string | undefined;
        if (file.status !== "removed") {
          try {
            content = await getFileContent(owner, repo, file.filename, headRef);
          } catch (error) {
            console.error(`Error retrieving content for ${file.filename}:`, error);
          }
        }
        return {
          filename: file.filename,
          patch: file.patch || "",
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          content
        };
      })
    );

    // We also get the commit messages in the PR, which can help inform the AI's analysis.
    const commitsRes = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number: pullNumber
    });
    const commitMessages = commitsRes.data.map((c) => c.commit.message);

    // Call our analyzeCode function to get the AI's review of these changes.
    const analysis = await analyzeCode(title, changedFiles, commitMessages);

    // Update our placeholder comment with the full review.
    await updateCommentWithReview(owner, repo, placeholderCommentId, analysis);

    console.log(`Submitted code review for PR #${pullNumber} in ${owner}/${repo}`);
  } catch (error) {
    console.error(`Failed to handle 'pull_request' opened event for PR #${pullNumber}`, error);
  }
}

// Create an Express application to serve our webhook endpoint.
const app = express();

// Use body-parser to handle JSON payloads in the webhook request.
app.use(bodyParser.json());

// If we have a "webhook proxy URL" (from Smee or similar), we can forward events from GitHub to our local server.
const WEBHOOK_PROXY_URL = process.env.WEBHOOK_PROXY_URL;
if (WEBHOOK_PROXY_URL) {
  // We instantiate a Smee client, which listens at the proxy URL and forwards events to our local server.
  const smee = new SmeeClient({
    source: WEBHOOK_PROXY_URL,
    target: `http://localhost:${process.env.PORT || 3000}/webhook`,
    logger: console
  });
  smee.start();
  console.log("Webhook proxy client started");
}

// A simple endpoint to indicate our bot is running.
app.get("/", (req, res) => {
  res.send("PR Review Bot is running");
});

// The webhook endpoint GitHub (or the Smee proxy) calls when an event occurs in the repository.
app.post("/webhook", async (req, res) => {
  try {
    // The event type is in the header. We're primarily looking for "pull_request" events.
    const eventType = req.headers["x-github-event"];
    const payload = req.body;

    // For a "pull_request" event, if the action is "opened", we handle it with our function above.
    if (eventType === "pull_request" && payload.action === "opened") {
      await handlePullRequestOpened(payload);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Start our server on the provided PORT, or fallback to 3000.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PR Review Bot listening on port ${PORT}`);
});
