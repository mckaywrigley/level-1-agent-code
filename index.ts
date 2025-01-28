import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { config } from "dotenv";

config({ path: ".env.local" });

const openai = createOpenAI({
  compatibility: "strict"
});

async function main() {
  console.log("Starting...");
  try {
    const { text, usage, experimental_providerMetadata } = await generateText({
      model: openai("o1-mini"),
      prompt: ""
    });

    console.log("-- TEXT --\n", text);
    console.log("\n\n\n--------------------------------\n\n\n");
    console.log("-- USAGE --\n", usage);

    // Get cached tokens count
    const cachedTokens = (experimental_providerMetadata?.openai?.cachedPromptTokens ?? 0) as number;
    const uncachedTokens = (usage.promptTokens - cachedTokens) as number;

    // Calculate costs with cache consideration
    const cachedInputCost = (cachedTokens / 1_000_000) * 1.5; // $1.50 per 1M cached tokens
    const uncachedInputCost = (uncachedTokens / 1_000_000) * 3.0; // $3.00 per 1M uncached tokens
    const outputCost = (usage.completionTokens / 1_000_000) * 12.0; // $12.00 per 1M output tokens
    const totalCost = cachedInputCost + uncachedInputCost + outputCost;

    console.log("-- COSTS --");
    console.log(`Cached input cost: $${cachedInputCost.toFixed(6)}`);
    console.log(`Uncached input cost: $${uncachedInputCost.toFixed(6)}`);
    console.log(`Output cost: $${outputCost.toFixed(6)}`);
    console.log(`Total cost: $${totalCost.toFixed(6)}`);
    console.log("\n\n\n--------------------------------\n\n\n");
  } catch (error) {
    console.error(error);
  }
}

main();
