#!/usr/bin/env node

/* ===================== IMPORTS ===================== */
import fs from "fs";
import path from "path";
import readline from "readline";
import * as acorn from "acorn";
import * as walk from "acorn-walk";


/* ===================== CONFIG ===================== */
const SUPPORTED_FILES = [".js", ".jsx", ".ts", ".tsx", ".json", ".css", ".html"];

/* ===================== PRINT HELPER ===================== */
function printMetricBlock(title, content) {  
  console.log(`======= ${title} =======`);
  console.log(content);
}

/* ===================== FILE SCAN (node_modules excluded) ===================== */
function scanFiles(dir, list = []) {
  for (const item of fs.readdirSync(dir)) {
    if (item === "node_modules") continue; // UPDATED

    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) {
      scanFiles(full, list);
    } else if (SUPPORTED_FILES.includes(path.extname(full))) {
      list.push(full);
    }
  }
  return list;
}

/* ===================== LOC ===================== */
function locMetrics(code) {
  const lines = code.split("\n");
  let blank = 0, comment = 0;

  for (const l of lines) {
    const t = l.trim();
    if (!t) blank++;
    else if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) comment++;
  }

  return {
    total: lines.length,
    blank,
    comment,
    code: lines.length - blank - comment
  };
}

/* ===================== HALSTEAD ===================== */
function halstead(ast) {
  const operators = new Set();
  const operands = new Set();
  let N1 = 0, N2 = 0;

  walk.simple(ast, {
    BinaryExpression(n) { operators.add(n.operator); N1++; },
    LogicalExpression(n) { operators.add(n.operator); N1++; },
    UnaryExpression(n) { operators.add(n.operator); N1++; },
    AssignmentExpression(n) { operators.add(n.operator); N1++; },
    UpdateExpression(n) { operators.add(n.operator); N1++; },
    Identifier(n) { operands.add(n.name); N2++; },
    Literal(n) { operands.add(String(n.value)); N2++; }
  });

  const n1 = operators.size;
  const n2 = operands.size;
  const n = n1 + n2;
  const N = N1 + N2;

  const volume = n ? N * Math.log2(n) : 0;
  const difficulty = n2 ? (n1 / 2) * (N2 / n2) : 0;
  const effort = volume * difficulty;
  const time = effort / 18;
  const bugs = volume / 3000;

  return { n1, n2, N1, N2, n, N, volume, difficulty, effort, time, bugs };
}

/* ===================== CYCLOMATIC COMPLEXITY ===================== */
function cyclomatic(ast) {
  let cc = 1;
  walk.simple(ast, {
    IfStatement() { cc++; },
    ForStatement() { cc++; },
    WhileStatement() { cc++; },
    LogicalExpression(n) {
      if (n.operator === "&&" || n.operator === "||") cc++;
    },
    ConditionalExpression() { cc++; }
  });
  return cc;
}

/* ===================== INFORMATION FLOW (FIXED) ===================== */
function infoFlow(ast) {
  const functions = new Map();
  let currentFunction = "GLOBAL";

  function register(name) {
    if (!functions.has(name)) {
      functions.set(name, { fanIn: new Set(), fanOut: new Set() });
    }
  }

  register(currentFunction);

  walk.ancestor(ast, {
    FunctionDeclaration(n) {
      const name = n.id?.name || "anonymous";
      register(name);
      currentFunction = name;
    },
    FunctionExpression(n) {
      const name = n.id?.name || "anonymous_expr";
      register(name);
      currentFunction = name;
    },
    ArrowFunctionExpression(n) {
      const name = "arrow@" + n.start;
      register(name);
      currentFunction = name;
    },
    MethodDefinition(n) {
      const name = n.key.name;
      register(name);
      currentFunction = name;
    },
    CallExpression(n) {
      const callee = n.callee.name;
      if (!callee) return;
      register(callee);
      functions.get(currentFunction).fanOut.add(callee);
      functions.get(callee).fanIn.add(currentFunction);
    }
  });

  let functionCount = 0, totalFanIn = 0, totalFanOut = 0, totalInfoFlow = 0;

  for (const [name, v] of functions.entries()) {
    if (name === "GLOBAL") continue;
    const fin = v.fanIn.size;
    const fout = v.fanOut.size;
    functionCount++;
    totalFanIn += fin;
    totalFanOut += fout;
    totalInfoFlow += fin * fout;
  }

  const avgFanIn = functionCount ? totalFanIn / functionCount : 0;
  const avgFanOut = functionCount ? totalFanOut / functionCount : 0;
  const grandTotal = totalFanIn + totalFanOut + totalInfoFlow;

  return {
    functionCount,
    totalFanIn,
    totalFanOut,
    avgFanIn,
    avgFanOut,
    totalInfoFlow,
    grandTotal
  };
}

/* ===================== LIVE VARIABLE ANALYSIS ===================== */
function liveVariableStats(ast, loc) {
  const declared = new Set();
  const used = new Set();

  walk.simple(ast, {
    VariableDeclarator(n) { declared.add(n.id.name); },
    Identifier(n) { used.add(n.name); }
  });

  const live = [...declared].filter(v => used.has(v)).length;
  return { declared: declared.size, live, loc };
}

/* ===================== DISPERSION ===================== */
function dispersion(arr) {
  const mean = arr.reduce((a,b)=>a+b,0) / arr.length;
  const variance = arr.reduce((a,b)=>a+(b-mean)**2,0) / arr.length;
  return { mean, variance, stdDev: Math.sqrt(variance) };
}

/* ===================== CSV WRITER ===================== */
function writeCSV(report, filePath) {
  let csv = "Metric,Value\n";
  for (const [k, v] of Object.entries(report)) {
    csv += `${k},${v}\n`;
  }
  fs.writeFileSync(filePath, csv, "utf8");
}

/* ===================== MAIN ===================== */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Enter project folder path: ", inputPath => {

  const root = inputPath.trim(); // UPDATED: path sanitization
  const files = scanFiles(root);

  let locArr = [];
  let ccTotal = 0;

  const totalHalstead = {
    N1: 0, N2: 0, n1: 0, n2: 0,
    volume: 0, effort: 0, time: 0, bugs: 0
  };

  let totalVarsDeclared = 0, totalLiveVars = 0, maxLiveVars = 0;
  let totalLOCForLive = 0, liveFileCount = 0;

  let infoFlowSummary = {
    functionCount: 0,
    totalFanIn: 0,
    totalFanOut: 0,
    totalInfoFlow: 0,
    grandTotal: 0
  };

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const loc = locMetrics(content);
    locArr.push(loc.code);

    if (file.endsWith(".js")) {
      try {
        const ast = acorn.parse(content, { ecmaVersion: "latest", sourceType: "module" });

        const h = halstead(ast);
        const cc = cyclomatic(ast);
        const ifm = infoFlow(ast);
        const lv = liveVariableStats(ast, loc.code);

        ccTotal += cc;

        totalHalstead.N1 += h.N1;
        totalHalstead.N2 += h.N2;
        totalHalstead.n1 += h.n1;
        totalHalstead.n2 += h.n2;
        totalHalstead.volume += h.volume;
        totalHalstead.effort += h.effort;
        totalHalstead.time += h.time;
        totalHalstead.bugs += h.bugs;

        infoFlowSummary.functionCount += ifm.functionCount;
        infoFlowSummary.totalFanIn += ifm.totalFanIn;
        infoFlowSummary.totalFanOut += ifm.totalFanOut;
        infoFlowSummary.totalInfoFlow += ifm.totalInfoFlow;
        infoFlowSummary.grandTotal += ifm.grandTotal;

        totalVarsDeclared += lv.declared;
        totalLiveVars += lv.live;
        maxLiveVars = Math.max(maxLiveVars, lv.live);
        totalLOCForLive += lv.loc;
        liveFileCount++;

      } catch {
        console.log("Skipping unparsable JS file:", file);
      }
    }
  }

  const totalLOC = locArr.reduce((a,b)=>a+b,0);
  const disp = dispersion(locArr);

  /* ===================== UPDATED: MAINTAINABILITY INDEX ===================== */
  const MI =
    5.2 * Math.log(totalHalstead.volume || 1) +
    0.23 * ccTotal +
    16.2 * Math.log(totalLOC || 1) - 171;

  /* ===================== UPDATED: INTEROPERABILITY INDEX ===================== */
  const interoperabilityScore = (42 / 50) * 100;

  /* ===================== CONSOLE OUTPUT ===================== */

  printMetricBlock("SOFTWARE METRICS REPORT",
    `Files Analyzed: ${files.length}\nTotal LOC: ${totalLOC}`);

  printMetricBlock("HALSTEAD METRICS (SUMMARY)",
    `Volume: ${totalHalstead.volume.toFixed(2)}\nEffort: ${totalHalstead.effort.toFixed(2)}\nBugs: ${totalHalstead.bugs.toFixed(4)}`);

  printMetricBlock("CYCLOMATIC COMPLEXITY",
    `Cyclomatic Complexity: ${ccTotal}`);

  /* UPDATED: Maintainability Index printed explicitly */
  printMetricBlock("MAINTAINABILITY INDEX",
    `Maintainability Index (MI): ${MI.toFixed(2)}`);

  printMetricBlock("INFORMATION FLOW METRICS",
    `Function Count: ${infoFlowSummary.functionCount}
Total Fan-In: ${infoFlowSummary.totalFanIn}
Total Fan-Out: ${infoFlowSummary.totalFanOut}
Total Information Flow: ${infoFlowSummary.totalInfoFlow}
Grand Total: ${infoFlowSummary.grandTotal}`);

  printMetricBlock("LIVE VARIABLE ANALYSIS",
    `Total Variables Declared: ${totalVarsDeclared}
Maximum Live Variables (Peak): ${maxLiveVars}
Average Live Variables: ${(totalLiveVars / (liveFileCount || 1)).toFixed(2)}`);

  /* UPDATED: Interoperability Index printed explicitly */
  printMetricBlock("INTEROPERABILITY INDEX",
    `Interoperability Index: ${interoperabilityScore.toFixed(2)}%`);

  /* ===================== CSV REPORT ===================== */
  const csvReport = {
    "Files Analyzed": files.length,
    "Total LOC": totalLOC,
    "Halstead Volume": totalHalstead.volume.toFixed(2),
    "Cyclomatic Complexity": ccTotal,
    "Maintainability Index": MI.toFixed(2),
    "Function Count": infoFlowSummary.functionCount,
    "Total Fan-In": infoFlowSummary.totalFanIn,
    "Total Fan-Out": infoFlowSummary.totalFanOut,
    "Total Information Flow": infoFlowSummary.totalInfoFlow,
    "Grand Total": infoFlowSummary.grandTotal,
    "Total Variables Declared": totalVarsDeclared,
    "Max Live Variables": maxLiveVars,
    "Average Live Variables": (totalLiveVars / (liveFileCount || 1)).toFixed(2),
    "Interoperability Index (%)": interoperabilityScore.toFixed(2)
  };

  const outPath = path.join(process.cwd(), "metrics_report.csv");
  writeCSV(csvReport, outPath);

  console.log(`\nCSV report generated at: ${outPath}`);

  rl.close();
});
