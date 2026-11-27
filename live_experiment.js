// Live-model comparison: 152 direct tools vs one run_code tool.
//
// Required environment variables:
//   OPENAI_API_BASE_URL, OPENAI_API_KEY, OPENAI_API_MODEL
//
// Usage:
//   node live_experiment.js ../github-mcp-server/pkg/github/__toolsnaps__
//
// This is intentionally dependency-free and does not modify the original experiment.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const TOOL_SNAPSHOT_DIR = process.argv[2];
const RUNS = Number(process.env.LIVE_RUNS || 10);
const OUTPUT_PATH = process.env.LIVE_OUTPUT || path.join(__dirname, "live_results.json");
const SUMMARY_PATH = process.env.LIVE_SUMMARY || path.join(__dirname, "live_summary.md");
const API_BASE_URL = (process.env.OPENAI_API_BASE_URL || "").replace(/\/$/, "");
const API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_API_MODEL || "";
const MAX_MODEL_CALLS = 8;
const MAX_API_RETRIES = 3;
const REQUEST_TIMEOUT_MS = Number(process.env.LIVE_REQUEST_TIMEOUT_MS || 180000);

if (!TOOL_SNAPSHOT_DIR) throw new Error("Pass the GitHub MCP __toolsnaps__ directory as argv[2]");
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error("LIVE_RUNS must be a positive integer");
for (const [name, value] of Object.entries({ OPENAI_API_BASE_URL: API_BASE_URL, OPENAI_API_KEY: API_KEY, OPENAI_API_MODEL: MODEL })) {
  if (!value) throw new Error(`${name} is required`);
}

const ghTools = fs.readdirSync(TOOL_SNAPSHOT_DIR)
  .filter((file) => file.endsWith(".snap") && !file.endsWith("_output.snap"))
  .sort()
  .map((file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(TOOL_SNAPSHOT_DIR, file), "utf8"));
    return { name: raw.name, description: raw.description, input_schema: raw.inputSchema };
  });

const crmTools = [
  {
    name: "crm_search_customers",
    description: "Search customers by name, email or phone. Returns full customer records.",
    input_schema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Name, email or phone to match" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
    },
  },
  {
    name: "crm_list_orders",
    description: "List a customer's orders with line items, newest first.",
    input_schema: {
      type: "object",
      required: ["customer_id"],
      properties: {
        customer_id: { type: "string", description: "Customer ID from crm_search_customers" },
        since: { type: "string", description: "ISO date; only orders on or after it" },
      },
    },
  },
];

function tsType(schema, indent = "  ") {
  if (!schema) return "unknown";
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  switch (schema.type) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "array": return `Array<${tsType(schema.items, indent)}>`;
    case "object": {
      const required = new Set(schema.required || []);
      const properties = Object.entries(schema.properties || {});
      if (!properties.length) return "Record<string, unknown>";
      return "{\n" + properties.map(([key, value]) =>
        (value.description ? `${indent}/** ${value.description.replace(/\s+/g, " ")} */\n` : "") +
        `${indent}${key}${required.has(key) ? "" : "?"}: ${tsType(value, indent + "  ")};`
      ).join("\n") + "\n" + indent.slice(2) + "}";
    }
    default: return "unknown";
  }
}

const toTS = (tool) => `/** ${tool.description.replace(/\s+/g, " ")} */\nexport function ${tool.name}(input: ${tsType(tool.input_schema)}): Promise<unknown>;\n`;

const allTools = ghTools.concat(crmTools);
if (ghTools.length !== 150 || allTools.length !== 152) {
  throw new Error(`Expected 150 GitHub + 2 CRM tools, found ${ghTools.length} + ${crmTools.length}`);
}

// Reproduce experiment.js's seeded CRM fixture exactly.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (items) => items[Math.floor(rnd() * items.length)];
const first = ["Priya", "Priyanka", "Priya", "Pria", "Priyal"];
const last = ["Shah", "Shah", "Shaw", "Sharma", "Shah"];
const customers = first.map((firstName, index) => ({
  id: `cus_${1000 + index}`,
  name: `${firstName} ${last[index]}`,
  email: `${firstName.toLowerCase()}.${last[index].toLowerCase()}${index}@example.com`,
  phone: `+1-703-555-01${10 + index}`,
  created_at: `202${index}-0${index + 1}-1${index}T10:00:00Z`,
  tier: pick(["gold", "silver", "bronze"]),
  address: {
    line1: `${100 + index * 7} Main St`,
    city: pick(["Falls Church", "Arlington", "Vienna"]),
    state: "VA",
    zip: `220${40 + index}`,
  },
  marketing_opt_in: rnd() > 0.5,
  notes: "Prefers email. Previous support tickets resolved.",
  lifetime_orders: 30 + index,
}));
const target = customers[0];
const skus = ["SKU-CHAIR", "SKU-DESK", "SKU-LAMP", "SKU-MONITOR", "SKU-CABLE", "SKU-MAT", "SKU-ARM"];
const today = Date.parse("2026-11-22T00:00:00Z");
const orders = Array.from({ length: 120 }, (_, index) => {
  const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
    const qty = 1 + Math.floor(rnd() * 3);
    const unitPrice = Math.round((10 + rnd() * 290) * 100) / 100;
    return { sku: pick(skus), qty, unit_price: unitPrice, line_total: Math.round(qty * unitPrice * 100) / 100 };
  });
  const day = Math.floor(rnd() * 365);
  return {
    order_id: `ord_${50000 + index}`,
    customer_id: target.id,
    placed_at: new Date(today - day * 864e5).toISOString(),
    status: pick(["delivered", "delivered", "delivered", "shipped", "refunded"]),
    items,
    subtotal: Math.round(items.reduce((sum, item) => sum + item.line_total, 0) * 100) / 100,
    shipping: { carrier: pick(["UPS", "FedEx", "USPS"]), tracking: `1Z${Math.floor(rnd() * 1e9)}` },
    currency: "USD",
  };
}).sort((a, b) => b.placed_at.localeCompare(a.placed_at));

const crm = {
  crm_search_customers: async ({ query }) => customers.filter((customer) =>
    customer.name.toLowerCase().includes(query.toLowerCase().split(" ")[0].slice(0, 4))
  ),
  crm_list_orders: async ({ customer_id, since }) => orders.filter((order) =>
    order.customer_id === customer_id && (!since || order.placed_at >= since)
  ),
};

const since = new Date(today - 90 * 864e5).toISOString().slice(0, 10);
const task = "How much did Priya Shah spend in the last 90 days? Exclude refunded orders.";
const truth = Math.round(orders
  .filter((order) => order.customer_id === target.id && order.placed_at >= since && order.status !== "refunded")
  .reduce((sum, order) => sum + order.subtotal, 0) * 100) / 100;
if (truth !== 15146.2) throw new Error(`CRM fixture drifted: expected 15146.2, found ${truth}`);

const runCodeTool = {
  name: "run_code",
  description: "Run a JavaScript async arrow function in a sandbox. The crm module is available as the global `crm`. Only values passed to console.log() are returned. No fetch, require, process, or other network/filesystem access is available. Pass the complete async arrow function as `code`, for example: async () => { console.log(await crm.some_tool({})); }",
  input_schema: {
    type: "object",
    required: ["code"],
    properties: { code: { type: "string", description: "A complete JavaScript async arrow function" } },
  },
};

const asOpenAITool = (tool) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
});

const listing = allTools.map((tool) => `${tool.name}.ts`).join("\n");
const crmDefinitions = crmTools.map(toTS).join("\n");
const fixtureDateContext = "The CRM snapshot's reference date (today) is 2026-11-22. Interpret relative dates from that date.";
const systemDirect = `You are a helpful assistant with access to tools. ${fixtureDateContext} Use the CRM tools to answer the user's question. Give the final dollar amount clearly.`;
const systemCode = `You are a helpful assistant with one tool, run_code. ${fixtureDateContext} Write one JavaScript async arrow function that performs the entire workflow: call the typed CRM functions through the global crm object, filter the data, calculate the total inside the sandbox, and console.log() only a compact result. Then use that result to answer the user. Do not calculate the order total yourself.\n\nAvailable tool files (the output of listing the tool directory):\n${listing}\n\nTypeScript definitions for the two relevant files:\n${crmDefinitions}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizedUsage(usage = {}) {
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? ((usage.prompt_tokens ?? usage.input_tokens ?? 0) + (usage.completion_tokens ?? usage.output_tokens ?? 0)),
    raw: usage,
  };
}

async function chatCompletion(messages, tools, runStats) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: "auto", temperature: 0 }),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      const parsed = JSON.parse(body);
      if (!parsed.choices?.[0]?.message) throw new Error(`Malformed API response: ${body.slice(0, 500)}`);
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_API_RETRIES || error.retryable === false) break;
      runStats.apiRetries++;
      await sleep(1000 * (2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function parseArguments(toolCall) {
  const value = toolCall.function?.arguments;
  if (typeof value === "object" && value !== null) return value;
  return JSON.parse(value || "{}");
}

async function executeDirectTool(name, args) {
  if (!Object.prototype.hasOwnProperty.call(crm, name)) throw new Error(`Tool ${name} is not implemented in this experiment`);
  return crm[name](args);
}

async function executeCode(code) {
  const logs = [];
  const sandbox = vm.createContext({
    crm,
    console: { log: (...values) => logs.push(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")) },
  });
  const result = vm.runInContext(`(${code})()`, sandbox, { timeout: 1000 });
  await Promise.race([
    result,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Async script timed out after 5 seconds")), 5000)),
  ]);
  return logs.join("\n");
}

function assistantMessageForHistory(message) {
  const saved = { role: "assistant", content: message.content ?? null };
  if (message.tool_calls) saved.tool_calls = message.tool_calls;
  return saved;
}

function answerMatches(answer) {
  if (!answer) return false;
  const amounts = [...answer.matchAll(/(?:\$\s*)?([0-9][0-9,]*(?:\.\d{1,2})?)/g)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter(Number.isFinite);
  return amounts.some((amount) => Math.abs(amount - truth) < 0.005);
}

async function runTrial(setup, index) {
  const isDirect = setup === "direct";
  const messages = [
    { role: "system", content: isDirect ? systemDirect : systemCode },
    { role: "user", content: task },
  ];
  const tools = isDirect ? allTools.map(asOpenAITool) : [asOpenAITool(runCodeTool)];
  const stats = {
    run: index + 1,
    setup,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    apiRetries: 0,
    toolCalls: 0,
    scriptExecutions: 0,
    failedScripts: 0,
    toolErrors: 0,
    answer: null,
    matchesTruth: false,
    completed: false,
    error: null,
    calls: [],
  };

  try {
    while (stats.modelCalls < MAX_MODEL_CALLS) {
      const response = await chatCompletion(messages, tools, stats);
      const usage = normalizedUsage(response.usage);
      stats.modelCalls++;
      stats.inputTokens += usage.inputTokens;
      stats.outputTokens += usage.outputTokens;
      stats.totalTokens += usage.totalTokens;
      const message = response.choices[0].message;
      const callRecord = {
        modelCall: stats.modelCalls,
        finishReason: response.choices[0].finish_reason ?? null,
        usage,
        toolNames: (message.tool_calls || []).map((call) => call.function?.name || null),
      };
      stats.calls.push(callRecord);
      messages.push(assistantMessageForHistory(message));

      if (!message.tool_calls?.length) {
        stats.answer = message.content || "";
        stats.matchesTruth = answerMatches(stats.answer);
        stats.completed = true;
        break;
      }

      for (const toolCall of message.tool_calls) {
        stats.toolCalls++;
        const name = toolCall.function?.name;
        let content;
        try {
          const args = parseArguments(toolCall);
          if (isDirect) {
            content = JSON.stringify(await executeDirectTool(name, args));
          } else {
            if (name !== "run_code") throw new Error(`Unexpected tool ${name}`);
            stats.scriptExecutions++;
            content = await executeCode(args.code);
          }
        } catch (error) {
          content = JSON.stringify({ error: error.message });
          stats.toolErrors++;
          if (!isDirect && name === "run_code") stats.failedScripts++;
        }
        messages.push({ role: "tool", tool_call_id: toolCall.id, content });
      }
    }
    if (!stats.completed) throw new Error(`No final answer after ${MAX_MODEL_CALLS} model calls`);
  } catch (error) {
    stats.error = error.message;
  }
  return stats;
}

function aggregate(runs) {
  const sum = (key) => runs.reduce((total, run) => total + run[key], 0);
  const completed = runs.filter((run) => run.completed).length;
  const correct = runs.filter((run) => run.matchesTruth).length;
  return {
    runs: runs.length,
    completed,
    correct,
    incorrectOrIncomplete: runs.length - correct,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    modelCalls: sum("modelCalls"),
    apiRetries: sum("apiRetries"),
    runsWithApiRetries: runs.filter((run) => run.apiRetries > 0).length,
    toolCalls: sum("toolCalls"),
    scriptExecutions: sum("scriptExecutions"),
    failedScripts: sum("failedScripts"),
    runsWithFailedScripts: runs.filter((run) => run.failedScripts > 0).length,
    toolErrors: sum("toolErrors"),
    averagesPerRun: {
      inputTokens: sum("inputTokens") / runs.length,
      outputTokens: sum("outputTokens") / runs.length,
      totalTokens: sum("totalTokens") / runs.length,
      modelCalls: sum("modelCalls") / runs.length,
    },
  };
}

function pctDelta(code, direct, key) {
  return direct[key] ? ((code[key] - direct[key]) / direct[key]) * 100 : null;
}

function summaryMarkdown(result) {
  const direct = result.aggregate.direct;
  const code = result.aggregate.codeMode;
  const format = (number) => Number.isInteger(number) ? String(number) : number.toFixed(1);
  const delta = (key) => {
    const value = result.comparison.codeModePercentChange[key];
    return value === null ? "n/a" : `${value.toFixed(1)}%`;
  };
  return `# Live model results\n\n` +
    `Model: \`${result.meta.model}\`. Ground truth: **$${truth.toLocaleString("en-US", { minimumFractionDigits: 2 })}**. Each setup ran ${RUNS} times. Token counts are the API-reported usage summed across every model call.\n\n` +
    `| Metric | 152 direct tools | Code Mode |\n|---|---:|---:|\n` +
    `| Correct answers | ${direct.correct}/${direct.runs} | ${code.correct}/${code.runs} |\n` +
    `| Completed answers | ${direct.completed}/${direct.runs} | ${code.completed}/${code.runs} |\n` +
    `| Input tokens | ${direct.inputTokens.toLocaleString()} total; ${format(direct.averagesPerRun.inputTokens)}/run | ${code.inputTokens.toLocaleString()} total; ${format(code.averagesPerRun.inputTokens)}/run |\n` +
    `| Output tokens | ${direct.outputTokens.toLocaleString()} total; ${format(direct.averagesPerRun.outputTokens)}/run | ${code.outputTokens.toLocaleString()} total; ${format(code.averagesPerRun.outputTokens)}/run |\n` +
    `| Model calls | ${direct.modelCalls} total; ${format(direct.averagesPerRun.modelCalls)}/run | ${code.modelCalls} total; ${format(code.averagesPerRun.modelCalls)}/run |\n` +
    `| API retries | ${direct.apiRetries}; ${direct.runsWithApiRetries}/${direct.runs} runs affected | ${code.apiRetries}; ${code.runsWithApiRetries}/${code.runs} runs affected |\n` +
    `| Failed scripts | n/a | ${code.failedScripts}/${code.scriptExecutions} executions, affecting ${code.runsWithFailedScripts}/${code.runs} runs |\n\n` +
    `Relative to direct tools, Code Mode changed API-reported input tokens by **${delta("inputTokens")}**, output tokens by **${delta("outputTokens")}**, and model calls by **${delta("modelCalls")}**.\n`;
}

async function main() {
  const startedAt = new Date().toISOString();
  const directRuns = [];
  const codeRuns = [];
  for (let index = 0; index < RUNS; index++) {
    process.stderr.write(`direct ${index + 1}/${RUNS}\n`);
    directRuns.push(await runTrial("direct", index));
  }
  for (let index = 0; index < RUNS; index++) {
    process.stderr.write(`code mode ${index + 1}/${RUNS}\n`);
    codeRuns.push(await runTrial("codeMode", index));
  }

  const directAggregate = aggregate(directRuns);
  const codeAggregate = aggregate(codeRuns);
  const result = {
    meta: {
      model: MODEL,
      apiBaseUrl: API_BASE_URL,
      startedAt,
      finishedAt: new Date().toISOString(),
      runsPerSetup: RUNS,
      githubTools: ghTools.length,
      crmTools: crmTools.length,
      totalDirectTools: allTools.length,
      temperature: 0,
      since,
      fixtureReferenceDate: "2026-11-22",
      task,
      apiKeyRecorded: false,
    },
    groundTruth: { value: truth, formatted: "$15,146.20" },
    setups: {
      direct: { description: "All 152 tools supplied as OpenAI function tools." },
      codeMode: { description: "One run_code function tool, plus the 152-file listing and two relevant TypeScript definitions in context." },
    },
    runs: { direct: directRuns, codeMode: codeRuns },
    aggregate: { direct: directAggregate, codeMode: codeAggregate },
    comparison: {
      codeModePercentChange: {
        inputTokens: pctDelta(codeAggregate, directAggregate, "inputTokens"),
        outputTokens: pctDelta(codeAggregate, directAggregate, "outputTokens"),
        totalTokens: pctDelta(codeAggregate, directAggregate, "totalTokens"),
        modelCalls: pctDelta(codeAggregate, directAggregate, "modelCalls"),
      },
    },
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + "\n");
  fs.writeFileSync(SUMMARY_PATH, summaryMarkdown(result));
  process.stderr.write(`wrote ${OUTPUT_PATH}\nwrote ${SUMMARY_PATH}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
