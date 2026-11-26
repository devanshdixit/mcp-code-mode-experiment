// Code Mode vs direct MCP tool calling: token accounting on real tool schemas.
// Tokenizer: cl100k_base (same family Cloudflare used via tiktoken). Claude's own
// tokenizer differs, so read the RATIOS, not the absolute counts.
// Usage: node experiment.js <toolsnaps_dir> > results.json
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { encode } = require("gpt-tokenizer/cjs/encoding/cl100k_base");
const T = (s) => encode(typeof s === "string" ? s : JSON.stringify(s)).length;

// ---------- 1. Real tool definitions: GitHub's official MCP server ----------
const dir = process.argv[2];
const ghTools = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".snap") && !f.endsWith("_output.snap"))
  .sort()
  .map((f) => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    return { name: j.name, description: j.description, input_schema: j.inputSchema };
  });

// A small CRM server for the reel's "find customer, then fetch orders" task.
const crmTools = [
  { name: "crm_search_customers",
    description: "Search customers by name, email or phone. Returns full customer records.",
    input_schema: { type: "object", required: ["query"], properties: {
      query: { type: "string", description: "Name, email or phone to match" },
      limit: { type: "number", description: "Max results (default 10)" } } } },
  { name: "crm_list_orders",
    description: "List a customer's orders with line items, newest first.",
    input_schema: { type: "object", required: ["customer_id"], properties: {
      customer_id: { type: "string", description: "Customer ID from crm_search_customers" },
      since: { type: "string", description: "ISO date; only orders on or after it" } } } },
];

// JSON Schema -> TypeScript declaration with doc comments (what Code Mode shows the model).
function tsType(s, ind = "  ") {
  if (!s) return "unknown";
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  switch (s.type) {
    case "string": return "string";
    case "number": case "integer": return "number";
    case "boolean": return "boolean";
    case "array": return `Array<${tsType(s.items, ind)}>`;
    case "object": {
      const req = new Set(s.required || []);
      const props = Object.entries(s.properties || {});
      if (!props.length) return "Record<string, unknown>";
      return "{\n" + props.map(([k, v]) =>
        (v.description ? `${ind}/** ${v.description.replace(/\s+/g, " ")} */\n` : "") +
        `${ind}${k}${req.has(k) ? "" : "?"}: ${tsType(v, ind + "  ")};`).join("\n") +
        "\n" + ind.slice(2) + "}";
    }
    default: return "unknown";
  }
}
const toTS = (t) => `/** ${t.description.replace(/\s+/g, " ")} */\nexport function ${t.name}(input: ${tsType(t.input_schema)}): Promise<unknown>;\n`;

const runCodeTool = { name: "run_code",
  description: "Run a TypeScript async function in a sandbox. MCP servers are available as typed modules (see the API below). Only what you console.log() is returned to you. No network access except through these modules.",
  input_schema: { type: "object", required: ["code"], properties: { code: { type: "string", description: "Async arrow function body" } } } };

// Tool sets of any size, built by cycling the real GitHub tools (renamed per copy) —
// stands in for "many servers"; every definition is a real one.
function toolset(n) {
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const t = ghTools[i % ghTools.length], copy = Math.floor(i / ghTools.length);
    out.push(copy ? { ...t, name: `${t.name}_s${copy}` } : t);
  }
  return out;
}

// ---------- 2. Definition overhead vs number of tools ----------
const needed = crmTools; // the two tools the task actually uses
const scaling = [10, 50, ghTools.length + crmTools.length, 500, 1000, 2500].map((n) => {
  const tools = toolset(n - crmTools.length).concat(crmTools);
  const direct = T(tools);                                     // all JSON definitions, every call
  const codeFull = T(runCodeTool) + T(tools.map(toTS).join("\n")); // Cloudflare v1: whole API as TS
  const listing = tools.map((t) => t.name + ".ts").join("\n");     // `ls servers/` output
  const codeLazy = T(runCodeTool) + T(listing) + T(needed.map(toTS).join("\n")); // Anthropic: load on demand
  return { tools: n, direct, codeFull, codeLazy };
});

// ---------- 3. The reel's workflow: find customer -> fetch orders -> answer ----------
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const first = ["Priya", "Priyanka", "Priya", "Pria", "Priyal"], last = ["Shah", "Shah", "Shaw", "Sharma", "Shah"];
const customers = first.map((f, i) => ({
  id: `cus_${1000 + i}`, name: `${f} ${last[i]}`, email: `${f.toLowerCase()}.${last[i].toLowerCase()}${i}@example.com`,
  phone: `+1-703-555-01${10 + i}`, created_at: `202${i}-0${i + 1}-1${i}T10:00:00Z`, tier: pick(["gold", "silver", "bronze"]),
  address: { line1: `${100 + i * 7} Main St`, city: pick(["Falls Church", "Arlington", "Vienna"]), state: "VA", zip: `220${40 + i}` },
  marketing_opt_in: rnd() > 0.5, notes: "Prefers email. Previous support tickets resolved.", lifetime_orders: 30 + i,
}));
const target = customers[0]; // "Priya Shah", cus_1000
const skus = ["SKU-CHAIR", "SKU-DESK", "SKU-LAMP", "SKU-MONITOR", "SKU-CABLE", "SKU-MAT", "SKU-ARM"];
const today = Date.parse("2026-11-22T00:00:00Z");
const orders = Array.from({ length: 120 }, (_, k) => {
  const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
    const qty = 1 + Math.floor(rnd() * 3), unit = Math.round((10 + rnd() * 290) * 100) / 100;
    return { sku: pick(skus), qty, unit_price: unit, line_total: Math.round(qty * unit * 100) / 100 };
  });
  const day = Math.floor(rnd() * 365);
  return { order_id: `ord_${50000 + k}`, customer_id: target.id,
    placed_at: new Date(today - day * 864e5).toISOString(), status: pick(["delivered", "delivered", "delivered", "shipped", "refunded"]),
    items, subtotal: Math.round(items.reduce((s, i) => s + i.line_total, 0) * 100) / 100,
    shipping: { carrier: pick(["UPS", "FedEx", "USPS"]), tracking: `1Z${Math.floor(rnd() * 1e9)}` }, currency: "USD" };
}).sort((a, b) => b.placed_at.localeCompare(a.placed_at));

// The fake MCP server the sandbox talks to.
const crm = {
  crm_search_customers: async ({ query }) => customers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase().split(" ")[0].slice(0, 4))),
  crm_list_orders: async ({ customer_id, since }) => orders.filter((o) => o.customer_id === customer_id && (!since || o.placed_at >= since)),
};

const system = "You are a helpful assistant with access to tools.";
const user = "How much did Priya Shah spend in the last 90 days? Exclude refunded orders.";
const since = new Date(today - 90 * 864e5).toISOString().slice(0, 10);

async function main() {
  // Ground truth
  const custHits = await crm.crm_search_customers({ query: "Priya Shah" });
  const ordHits = await crm.crm_list_orders({ customer_id: target.id, since });
  const truth = Math.round(ordHits.filter((o) => o.status !== "refunded").reduce((s, o) => s + o.subtotal, 0) * 100) / 100;

  // The script a model would write in code mode. Run it for real in a sandbox.
  const script = `async () => {
  const [c] = (await crm.crm_search_customers({ query: "Priya Shah" }))
    .filter(x => x.name === "Priya Shah");
  const orders = await crm.crm_list_orders({ customer_id: c.id, since: "${since}" });
  const kept = orders.filter(o => o.status !== "refunded");
  const total = kept.reduce((s, o) => s + o.subtotal, 0);
  console.log(JSON.stringify({ customer: c.id, orders: kept.length, total: total.toFixed(2) }));
}`;
  const logs = [];
  const sandbox = vm.createContext({ crm, console: { log: (s) => logs.push(String(s)) } }); // no fetch, no require
  await vm.runInContext(`(${script})()`, sandbox, { timeout: 1000 });
  const printed = logs.join("\n");

  const answer = `Priya Shah (cus_1000) spent $${JSON.parse(printed).total} across ${JSON.parse(printed).orders} non-refunded orders since ${since}.`;
  const call1 = { tool: "crm_search_customers", input: { query: "Priya Shah" } };
  const call2 = { tool: "crm_list_orders", input: { customer_id: "cus_1000", since } };

  function runs(nTools) {
    const tools = toolset(nTools - crmTools.length).concat(crmTools);
    // Direct: 3 model calls; each re-reads the defs and the growing history.
    const D = T(system) + T(tools) + T(user);
    const r1 = T(custHits), r2 = T(ordHits);
    const direct = {
      calls: 3,
      input: D + (D + T(call1) + r1) + (D + T(call1) + r1 + T(call2) + r2),
      output: T(call1) + T(call2) + T(answer),
      intermediateThroughModel: r1 + r2,
    };
    // Code mode, whole API up front (Cloudflare 2025 post): 2 model calls.
    const F = T(system) + T(runCodeTool) + T(tools.map(toTS).join("\n")) + T(user);
    const codeFull = { calls: 2, input: F + (F + T(script) + T(printed)), output: T(script) + T(answer), intermediateThroughModel: T(printed) };
    // Code mode, load on demand (Anthropic post): ls, read 2 files, run code, answer = 4 calls.
    const L0 = T(system) + T(runCodeTool) + T(user);
    const ls = T(tools.map((t) => t.name + ".ts").join("\n")), defs = T(crmTools.map(toTS).join("\n"));
    const lsCall = T({ tool: "run_code", input: { code: "ls servers/" } }), rdCall = T({ tool: "run_code", input: { code: "cat servers/crm/*.ts" } });
    const steps = [L0, L0 + lsCall + ls, L0 + lsCall + ls + rdCall + defs, L0 + lsCall + ls + rdCall + defs + T(script) + T(printed)];
    const codeLazy = { calls: 4, input: steps.reduce((a, b) => a + b, 0), output: lsCall + rdCall + T(script) + T(answer), intermediateThroughModel: T(printed) };
    const parts = { system: T(system), user: T(user), toolDefs: T(tools), call1: T(call1), result1: r1, call2: T(call2), result2: r2,
      runCodeTool: T(runCodeTool), lsCall, listing: ls, readCall: rdCall, neededDefs: defs, script: T(script), printed: T(printed), answer: T(answer) };
    return { tools: nTools, direct, codeFull, codeLazy, parts };
  }

  const out = {
    meta: { tokenizer: "cl100k_base (gpt-tokenizer)", githubTools: ghTools.length, crmTools: crmTools.length,
      avgDefTokensGithub: Math.round(T(ghTools) / ghTools.length), since },
    scaling,
    workflow: [ghTools.length + crmTools.length, 1000].map(runs),
    sizes: { customerSearchResult: T(custHits), orderListResult: T(ordHits), printedByScript: T(printed), script: T(script), customersReturned: custHits.length, ordersReturned: ordHits.length },
    correctness: { truth, scriptTotal: Number(JSON.parse(printed).total), match: Math.abs(truth - Number(JSON.parse(printed).total)) < 0.005 },
    printed, script,
    sampleTS: toTS(ghTools.find((t) => t.name === "search_issues")).slice(0, 600),
  };
  console.log(JSON.stringify(out, null, 2));
}
main();
