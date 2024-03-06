// src/cli.ts
import { command, flag, option, restPositionals, run, string } from "cmd-ts";
import { ESLint } from "eslint";

// src/processor.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync } from "node:fs";

// src/baseline/baseline.ts
import path from "node:path";

// src/baseline/helper.ts
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
function buildRange(startLine, startColumn, endLine, endColumn) {
  return {
    start: {
      line: startLine,
      column: startColumn
    },
    end: {
      line: endLine ?? startLine,
      column: endColumn ?? startColumn
    }
  };
}
var LINES_PATTERN = /(.*?(?:\r\n?|\n|$))/gm;
var _sourceCache = /* @__PURE__ */ new Map();
function readSource(filePath) {
  if (!filePath) {
    return "";
  }
  if (existsSync(filePath) && !_sourceCache.has(filePath)) {
    const source = readFileSync(filePath, { encoding: "utf8" });
    _sourceCache.set(filePath, source);
  }
  return _sourceCache.get(filePath) || "";
}
function getSourceForRange(source, range) {
  if (!source) {
    return "";
  }
  const sourceLines = source.match(LINES_PATTERN) || [];
  const firstLine = range.start.line - 1;
  const lastLine = range.end.line - 1;
  let currentLine = firstLine - 1;
  const firstColumn = range.start.column - 1;
  const lastColumn = range.end.column - 1;
  const src = [];
  let line;
  while (currentLine < lastLine) {
    currentLine++;
    line = sourceLines[currentLine];
    if (currentLine === firstLine) {
      if (firstLine === lastLine) {
        src.push(line.slice(firstColumn, lastColumn));
      } else {
        src.push(line.slice(firstColumn));
      }
    } else if (currentLine === lastLine) {
      src.push(line.slice(0, lastColumn));
    } else {
      src.push(line);
    }
  }
  return src.join("");
}
function hashSourceCode(sourceCode) {
  return createHash("sha256").update(sourceCode).digest("hex");
}
function lintMessageToLintViolation(message, opts) {
  if (message.ruleId === null) {
    throw new Error("Expected message.ruleId to be a string.");
  }
  const range = buildRange(
    message.line,
    message.column,
    message.endLine,
    message.endColumn
  );
  const sourceFile = readSource(opts.filePath);
  const sourceCode = getSourceForRange(sourceFile, range);
  return {
    filePath: opts.filePath,
    startLine: message.line,
    startColumn: message.column,
    endLine: message.endLine,
    endColumn: message.endColumn,
    ruleId: message.ruleId,
    hash: sourceCode ? hashSourceCode(sourceCode) : void 0,
    message: message.message,
    severity: message.severity
  };
}

// src/baseline/baseline.ts
var HashBaseline = class _HashBaseline {
  violations = /* @__PURE__ */ new Map();
  static fromResults(results, opts) {
    const baseline = new _HashBaseline();
    for (const result of results) {
      const filePath = path.relative(opts.cwd, result.filePath);
      for (const message of result.messages) {
        if (message.ruleId === null) {
          continue;
        }
        const violation = lintMessageToLintViolation(message, {
          filePath
        });
        baseline.addViolation(violation);
      }
    }
    return baseline;
  }
  addViolation(violation) {
    const violationsForFile = this.violations.get(violation.filePath) ?? [];
    violationsForFile.push(violation);
    this.violations.set(violation.filePath, violationsForFile);
  }
  getViolations() {
    return Array.from(this.violations.values()).flat();
  }
  hasFileViolation(violation) {
    const violationsForFile = this.violations.get(violation.filePath) ?? [];
    return violationsForFile.some((v) => this.violationsMatch(v, violation));
  }
  violationsMatch(v1, v2) {
    return this.violationsMatchByHash(v1, v2) || this.violationsMatchByLocationAndMessage(v1, v2);
  }
  violationsMatchByHash(v1, v2) {
    return v1.hash !== "" && v2.hash !== "" && v1.hash === v2.hash;
  }
  violationsMatchByLocationAndMessage(v1, v2) {
    return v1.filePath === v2.filePath && v1.startLine === v2.startLine && v1.startColumn === v2.startColumn && v1.endLine === v2.endLine && v1.endColumn === v2.endColumn && v1.message === v2.message;
  }
};

// src/baseline/build.ts
function createBuilder(opts) {
  return (results) => HashBaseline.fromResults(results, {
    cwd: opts.cwd
  });
}

// src/baseline/filter.ts
import path2 from "node:path";
function createFilter(opts) {
  return (results, baseline) => {
    const newResults = [];
    for (const result of results) {
      const filePath = path2.relative(opts.cwd, result.filePath);
      const newResult = {
        ...result,
        messages: [],
        errorCount: 0,
        fatalErrorCount: 0,
        warningCount: 0,
        fixableErrorCount: 0,
        fixableWarningCount: 0
      };
      for (const message of result.messages) {
        if (message.ruleId !== null) {
          const violation = lintMessageToLintViolation(message, {
            filePath
          });
          if (baseline.hasFileViolation(violation)) {
            continue;
          }
        }
        if (message.severity === 2) {
          newResult.errorCount += 1;
        } else if (message.severity === 1) {
          newResult.warningCount += 1;
        }
        if (message.fix) {
          if (message.severity === 2) {
            newResult.fixableErrorCount += 1;
          } else if (message.severity === 1) {
            newResult.fixableWarningCount += 1;
          }
        }
        if (message.fatal) {
          newResult.fatalErrorCount += 1;
        }
        newResult.messages.push(message);
      }
      newResults.push(newResult);
    }
    return newResults;
  };
}

// src/baseline/serialize.ts
import { z } from "zod";
var schema = z.object({
  files: z.record(
    z.object({
      errors: z.array(
        z.object({
          ruleId: z.string(),
          message: z.string(),
          severity: z.number(),
          hash: z.string().optional()
        })
      )
    })
  )
});
function createSerializer() {
  const buildKey = (violation) => {
    let key = `${violation.filePath}:${violation.startLine}:${violation.startColumn}`;
    if (violation.endLine !== void 0 && violation.endColumn !== void 0) {
      key += `-${violation.endLine}:${violation.endColumn}`;
    }
    return key;
  };
  const readKey = (key) => {
    const [filePath, startLine, startColumn, endLine, endColumn] = key.split(":");
    if (!filePath || !startLine || !startColumn) {
      throw new Error(`Invalid key: ${key}`);
    }
    return {
      filePath,
      startLine: Number(startLine),
      startColumn: Number(startColumn),
      endLine: endLine ? Number(endLine.slice(1)) : void 0,
      endColumn: endColumn ? Number(endColumn) : void 0
    };
  };
  const serialize = (baseline) => {
    const output = {
      files: {}
    };
    for (const violation of baseline.getViolations()) {
      const key = buildKey(violation);
      const file = output.files[key] ??= {
        errors: []
      };
      file.errors.push({
        ruleId: violation.ruleId,
        message: violation.message,
        severity: violation.severity,
        hash: violation.hash
      });
    }
    return JSON.stringify(output, null, 2);
  };
  const deserialize = (text) => {
    const input = schema.parse(JSON.parse(text));
    const baseline = new HashBaseline();
    for (const [key, file] of Object.entries(input.files)) {
      const { filePath, startLine, startColumn, endLine, endColumn } = readKey(key);
      for (const error of file.errors) {
        baseline.addViolation({
          ...error,
          filePath,
          startLine,
          startColumn,
          endLine,
          endColumn
        });
      }
    }
    return baseline;
  };
  return {
    serialize,
    deserialize
  };
}

// src/baseline/engine.ts
var createEngine = (opts) => {
  const serializer = createSerializer();
  return {
    build: createBuilder({ cwd: opts.cwd }),
    filter: createFilter({ cwd: opts.cwd }),
    serialize: serializer.serialize,
    deserialize: serializer.deserialize
  };
};

// src/processor.ts
var Processor = class {
  engine;
  baselineFile;
  updateBaseline;
  constructor(opts) {
    this.baselineFile = opts.baselineFile;
    this.updateBaseline = opts.updateBaseline;
    this.engine = createEngine({
      cwd: opts.cwd
    });
  }
  process(results) {
    if (existsSync2(this.baselineFile)) {
      return this.handleBaselineExists(results);
    } else {
      return this.handleBaselineDoesNotExist(results);
    }
  }
  handleBaselineExists(results) {
    let baseline = this.engine.deserialize(
      readFileSync2(this.baselineFile, "utf8")
    );
    if (this.updateBaseline) {
      baseline = this.engine.build(results);
      writeFileSync(this.baselineFile, this.engine.serialize(baseline));
    }
    return this.engine.filter(results, baseline);
  }
  handleBaselineDoesNotExist(results) {
    const baseline = this.engine.build(results);
    writeFileSync(this.baselineFile, this.engine.serialize(baseline));
    return results;
  }
};

// src/cli.ts
var app = command({
  name: "eslint-baseline",
  description: "Run ESLint with a baseline",
  args: {
    baseline: option({
      long: "baseline-file",
      description: "Path to the baseline file",
      defaultValue: () => ".eslint-baseline.json",
      type: string
    }),
    update: flag({
      long: "update-baseline",
      short: "u",
      description: "Update the baseline file",
      defaultValue: () => false
    }),
    cwd: option({
      long: "cwd",
      defaultValue: () => process.cwd(),
      description: "The current working directory. Files in the baseline are resolved relative to this.",
      type: string
    }),
    files: restPositionals({
      description: "Files to lint. This is passed to ESLint.",
      type: string
    })
  },
  handler: async (args) => {
    const eslint = new ESLint({
      cwd: args.cwd
    });
    const processor = new Processor({
      cwd: args.cwd,
      baselineFile: args.baseline,
      updateBaseline: args.update
    });
    const results = await eslint.lintFiles(args.files);
    const processedResults = processor.process(results);
    const rulesMeta = eslint.getRulesMetaForResults(processedResults);
    const formatter = await eslint.loadFormatter();
    const formatted = await formatter.format(processedResults, {
      cwd: args.cwd,
      rulesMeta
    });
    process.stdout.write(formatted);
    process.exitCode = processedResults.some((r) => r.errorCount > 0) ? 1 : 0;
  }
});
await run(app, process.argv.slice(2));
