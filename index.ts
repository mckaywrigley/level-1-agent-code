import { config } from "dotenv";
import OpenAI from "openai";

config({ path: ".env.local" });

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY
  // baseURL: "https://api.deepseek.com",
  // apiKey: process.env.DEEPSEEK_API_KEY
  // baseURL: "https://api.groq.com/openai/v1",
  // apiKey: process.env.GROQ_API_KEY
});

// const enhancedModel = wrapLanguageModel({
//   model: groq("deepseek-r1-distill-llama-70b"),
//   middleware: extractReasoningMiddleware({ tagName: "think" })
// });

async function main() {
  console.log("Starting...");
  try {
    const response = await openai.chat.completions.create({
      // model: "deepseek-reasoner",
      model: "deepseek/deepseek-r1",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "How do I connect to the gmail api using typescript?" }
      ]
      // stream: true
    });

    console.log(response);

    // for await (const chunk of response) {
    //   console.log(chunk.choices[0].delta);
    // }

    // const { text, reasoning, usage, ...rest } = await generateText({
    //   model: enhancedModel,
    //   messages: [
    //     { role: "system", content: "You are a helpful assistant." },
    //     { role: "user", content: "How do I connect to the gmail api using typescript?" }
    //   ]
    // });
    // console.log("-- REST --\n", rest);
    // console.log("\n\n\n--------------------------------\n\n\n");
    // console.log("-- TEXT --\n", text);
    // console.log("\n\n\n--------------------------------\n\n\n");
    // console.log("-- REASONING --\n", reasoning);
    // console.log("\n\n\n--------------------------------\n\n\n");
    // console.log("-- USAGE --\n", usage);
    // console.log("\n\n\n--------------------------------\n\n\n");
  } catch (error) {
    console.error(error);
  }
}

main();
