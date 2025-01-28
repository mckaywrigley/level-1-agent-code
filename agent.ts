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

interface FileChange {
  filename: string;
  patch: string;
  status: string;
  additions: number;
  deletions: number;
  content?: string;
}

interface CodeAnalysis {
  summary: string;
  fileAnalyses: {
    path: string;
    analysis: string;
  }[];
  overallSuggestions: string[];
}

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

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY environment variable.");
}

const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: APP_ID,
    privateKey: PRIVATE_KEY,
    installationId: INSTALLATION_ID
  }
});

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  compatibility: "strict"
});

async function getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | undefined> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path, ref });
    if ("content" in response.data && typeof response.data.content === "string") {
      return Buffer.from(response.data.content, "base64").toString();
    }
    return undefined;
  } catch (error: any) {
    if (error.status === 404) {
      console.log(`File ${path} not found at ref ${ref}`);
      return undefined;
    }
    throw error;
  }
}

async function parseReviewXml(xmlText: string): Promise<CodeAnalysis> {
  try {
    const xmlStart = xmlText.indexOf("<review>");
    const xmlEnd = xmlText.indexOf("</review>") + "</review>".length;

    if (xmlStart === -1 || xmlEnd === -1) {
      console.warn("Could not locate <review> tags in the AI response. Returning fallback.");
      return {
        summary: "AI analysis could not parse the response from the model.",
        fileAnalyses: [],
        overallSuggestions: []
      };
    }

    const xmlResponse = xmlText.slice(xmlStart, xmlEnd);
    const parsed = await parseStringPromise(xmlResponse);

    if (!parsed.review || !parsed.review.summary || !parsed.review.fileAnalyses || !parsed.review.overallSuggestions) {
      console.warn("Parsed XML is missing required fields. Returning fallback.");
      return {
        summary: "AI analysis returned incomplete or invalid XML structure.",
        fileAnalyses: [],
        overallSuggestions: []
      };
    }

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
    console.error("Error parsing AI-generated XML:", err);
    return {
      summary: "We were unable to fully parse the AI-provided code analysis.",
      fileAnalyses: [],
      overallSuggestions: []
    };
  }
}

async function analyzeCode(title: string, changedFiles: FileChange[], commitMessages: string[]): Promise<CodeAnalysis> {
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
    const { text } = await generateText({
      model: openai("o1-mini"),
      prompt
    });

    return await parseReviewXml(text);
  } catch (error) {
    console.error("Error generating or parsing AI analysis:", error);
    return {
      summary: "We were unable to analyze the code due to an internal error.",
      fileAnalyses: [],
      overallSuggestions: []
    };
  }
}

async function postPlaceholderComment(owner: string, repo: string, pullNumber: number): Promise<number> {
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: "PR Review Bot is analyzing your changes... Please wait."
  });
  return data.id;
}

async function updateCommentWithReview(owner: string, repo: string, commentId: number, analysis: CodeAnalysis) {
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

  await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: finalReviewBody
  });
}

async function handlePullRequestOpened(payload: any) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const pullNumber = payload.pull_request.number;
  const title = payload.pull_request.title;
  const headRef = payload.pull_request.head.sha;

  try {
    const placeholderCommentId = await postPlaceholderComment(owner, repo, pullNumber);

    const filesRes = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber
    });

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

    const commitsRes = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number: pullNumber
    });
    const commitMessages = commitsRes.data.map((c) => c.commit.message);

    const analysis = await analyzeCode(title, changedFiles, commitMessages);

    await updateCommentWithReview(owner, repo, placeholderCommentId, analysis);

    console.log(`Submitted code review for PR #${pullNumber} in ${owner}/${repo}`);
  } catch (error) {
    console.error(`Failed to handle 'pull_request' opened event for PR #${pullNumber}`, error);
  }
}

const app = express();
app.use(bodyParser.json());

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

app.get("/", (req, res) => {
  res.send("PR Review Bot is running");
});

app.post("/webhook", async (req, res) => {
  try {
    const eventType = req.headers["x-github-event"];
    const payload = req.body;

    if (eventType === "pull_request" && payload.action === "opened") {
      await handlePullRequestOpened(payload);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PR Review Bot listening on port ${PORT}`);
});
