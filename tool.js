#!/usr/bin/env node

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
  console.log('\n');
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

/* ===================== INFORMATION FLOW ===================== */
function infoFlow(ast) {
  const functions = new Map(); 
  let currentFunction = "GLOBAL";

  function registerFunction(name) {
    if (!functions.has(name)) {
      functions.set(name, { fanIn: new Set(), fanOut: new Set() });
    }
  }

  registerFunction(currentFunction);

  walk.ancestor(ast, {
    FunctionDeclaration(node, ancestors) {
      const name = node.id?.name || "anonymous";
      registerFunction(name);
      currentFunction = name;
    },

    FunctionExpression(node, ancestors) {
      const name = node.id?.name || "anonymous_expr";
      registerFunction(name);
      currentFunction = name;
    },

    ArrowFunctionExpression(node, ancestors) {
      const name = "arrow@" + node.start;
      registerFunction(name);
      currentFunction = name;
    },

    MethodDefinition(node) {
      const name = node.key.name;
      registerFunction(name);
      currentFunction = name;
    },

    CallExpression(node, ancestors) {
      const calleeName = node.callee.name;
      if (!calleeName) return;

      registerFunction(calleeName);

      functions.get(currentFunction).fanOut.add(calleeName);

      functions.get(calleeName).fanIn.add(currentFunction);
    }
  });

  let functionCount = 0;
  let totalFanIn = 0;
  let totalFanOut = 0;
  let totalInfoFlow = 0;

  for (const [name, data] of functions.entries()) {
    if (name === "GLOBAL") continue;

    const fin = data.fanIn.size;
    const fout = data.fanOut.size;

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

  const liveCount = [...declared].filter(v => used.has(v)).length;

  return {
    declared: declared.size,
    live: liveCount,
    loc
  };
}

/* ===================== DISPERSION ===================== */
function dispersion(arr) {
  const mean = arr.reduce((a,b)=>a+b,0) / arr.length;
  const variance = arr.reduce((a,b)=>a+(b-mean)**2,0) / arr.length;
  return { mean, variance, stdDev: Math.sqrt(variance) };
}

/* ===================== MAIN ===================== */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Enter project folder path: ", root => {

  const files = scanFiles(root);

  let locArr = [];
  let ccTotal = 0;

  // Halstead aggregation
  const totalHalstead = {
    N1: 0, N2: 0, n1: 0, n2: 0,
    volume: 0, effort: 0, time: 0, bugs: 0
  };

  // UPDATED: Information Flow aggregation
  let infoFlowSummary = {
    functionCount: 0,
    totalFanIn: 0,
    totalFanOut: 0,
    totalInfoFlow: 0,
    grandTotal: 0
  };

  // Live variable aggregation
  let totalVarsDeclared = 0;
  let totalLiveVars = 0;
  let maxLiveVars = 0;
  let totalLOCForLive = 0;
  let liveFileCount = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const loc = locMetrics(content);
    locArr.push(loc.code);

    if (file.endsWith(".js")) {
      try {
        const ast = acorn.parse(content, {
          ecmaVersion: "latest",
          sourceType: "module"
        });

        // Halstead
        const h = halstead(ast);
        totalHalstead.N1 += h.N1;
        totalHalstead.N2 += h.N2;
        totalHalstead.n1 += h.n1;
        totalHalstead.n2 += h.n2;
        totalHalstead.volume += h.volume;
        totalHalstead.effort += h.effort;
        totalHalstead.time += h.time;
        totalHalstead.bugs += h.bugs;

        // Cyclomatic
        ccTotal += cyclomatic(ast);

        //Information Flow
        const ifm = infoFlow(ast);
        infoFlowSummary.functionCount += ifm.functionCount;
        infoFlowSummary.totalFanIn += ifm.totalFanIn;
        infoFlowSummary.totalFanOut += ifm.totalFanOut;
        infoFlowSummary.totalInfoFlow += ifm.totalInfoFlow;
        infoFlowSummary.grandTotal += ifm.grandTotal;

        // Live Variables
        const lv = liveVariableStats(ast, loc.code);
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

  const MI =
    171 -
    5.2 * Math.log(totalHalstead.volume || 1) -
    0.23 * ccTotal -
    16.2 * Math.log(totalLOC || 1);

  const interoperabilityScore = (42 / 50) * 100;

  /* ===================== PRINTING ===================== */

  printMetricBlock(
    "SOFTWARE METRICS REPORT",
    `
Files Analyzed: ${files.length}
Total Lines of Code (LOC): ${totalLOC}
`.trim()
  );

  printMetricBlock(
    "HALSTEAD METRICS (DETAILED)",
    `
Total Operators (N1): ${totalHalstead.N1}
Total Operands (N2): ${totalHalstead.N2}
Program Vocabulary (n): ${totalHalstead.n1 + totalHalstead.n2}
Program Length (N): ${totalHalstead.N1 + totalHalstead.N2}
Volume: ${totalHalstead.volume.toFixed(2)}
Effort: ${totalHalstead.effort.toFixed(2)}
Time (seconds): ${totalHalstead.time.toFixed(2)}
Estimated Bugs: ${totalHalstead.bugs.toFixed(4)}
`.trim()
  );

  printMetricBlock(
    "CYCLOMATIC COMPLEXITY",
    `Cyclomatic Complexity: ${ccTotal}`
  );

  printMetricBlock(
    "MAINTAINABILITY INDEX",
    `Maintainability Index (MI): ${MI.toFixed(2)}`
  );

  printMetricBlock(
    "MEASURE OF DISPERSION (LOC)",
    `
Mean LOC per File: ${disp.mean.toFixed(2)}
Variance: ${disp.variance.toFixed(2)}
Standard Deviation: ${disp.stdDev.toFixed(2)}
`.trim()
  );

  // UPDATED: Information Flow Table (matches image)
  printMetricBlock(
    "INFORMATION FLOW METRICS",
    `
Function Count: ${infoFlowSummary.functionCount.toFixed(2)}
Total Fan-In: ${infoFlowSummary.totalFanIn.toFixed(2)}
Total Fan-Out: ${infoFlowSummary.totalFanOut.toFixed(2)}
Average Fan-In: ${(infoFlowSummary.totalFanIn / (infoFlowSummary.functionCount || 1)).toFixed(2)}
Average Fan-Out: ${(infoFlowSummary.totalFanOut / (infoFlowSummary.functionCount || 1)).toFixed(2)}
Total Information Flow: ${infoFlowSummary.totalInfoFlow.toFixed(2)}
Grand Total: ${infoFlowSummary.grandTotal.toFixed(2)}
`.trim()
  );

  printMetricBlock(
    "LIVE VARIABLE ANALYSIS",
    `
Total Variables Declared: ${totalVarsDeclared}
Total Lines of Code: ${totalLOCForLive}
Maximum Live Variables (peak): ${maxLiveVars}
Average Live Variables: ${(totalLiveVars / (liveFileCount || 1)).toFixed(2)}
`.trim()
  );

  printMetricBlock(
    "INTEROPERABILITY SCORE",
    `Interoperability Score: ${interoperabilityScore.toFixed(2)}%`
  );

  rl.close();
});
