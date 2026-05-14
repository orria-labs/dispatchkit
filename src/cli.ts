#!/usr/bin/env bun
import { generateRuntime, watchRuntime } from "./generate.ts";

type CliArgs = {
  command: "generate";
  watch: boolean;
  rootDir?: string;
  srcDir?: string;
  generatedDir?: string;
  intervalMs?: number;
};

function printUsage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  dispatchkit generate [--watch] [--rootDir <path>] [--srcDir <path>] [--generatedDir <path>] [--intervalMs <ms>]",
      "",
      "Examples:",
      "  dispatchkit generate",
      "  dispatchkit generate --watch",
      "  dispatchkit generate --srcDir ./src --generatedDir ./src/generated/runtime",
      "",
    ].join("\n"),
  );
}

function parseCliArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const firstToken = args[0];
  if (firstToken === "--help" || firstToken === "-h") {
    printUsage();
    process.exit(0);
  }

  const commandRaw = args.shift();
  const command = commandRaw ?? "generate";

  if (command !== "generate") {
    throw new Error(`Unknown command "${command}"`);
  }

  const parsed: CliArgs = {
    command: "generate",
    watch: false,
  };

  while (args.length > 0) {
    const token = args.shift();
    if (!token) continue;

    switch (token) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      case "--watch":
        parsed.watch = true;
        break;
      case "--rootDir":
        parsed.rootDir = args.shift();
        break;
      case "--srcDir":
        parsed.srcDir = args.shift();
        break;
      case "--generatedDir":
        parsed.generatedDir = args.shift();
        break;
      case "--intervalMs": {
        const raw = args.shift();
        if (!raw) {
          throw new Error("--intervalMs expects a numeric value");
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 50) {
          throw new Error("--intervalMs must be a number >= 50");
        }
        parsed.intervalMs = Math.floor(value);
        break;
      }
      default:
        throw new Error(`Unknown option "${token}"`);
    }
  }

  return parsed;
}

function renderError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function run(): Promise<void> {
  try {
    const parsed = parseCliArgs(process.argv.slice(2));

    if (parsed.command === "generate") {
      if (parsed.watch) {
        await watchRuntime({
          rootDir: parsed.rootDir,
          srcDir: parsed.srcDir,
          generatedDir: parsed.generatedDir,
          intervalMs: parsed.intervalMs,
          onInfo: (message) => process.stdout.write(`${message}\n`),
          onError: (error) => process.stderr.write(`[dispatchkit] ${renderError(error)}\n`),
        });
        return;
      }

      const result = await generateRuntime({
        rootDir: parsed.rootDir,
        srcDir: parsed.srcDir,
        generatedDir: parsed.generatedDir,
      });

      process.stdout.write(
        `[dispatchkit] generated runtime artifacts in ${result.generatedDir}: ${result.discovery.operations.length} ops, ${result.discovery.infra.length} infra modules, ${result.discovery.transport.length} transport modules\n`,
      );
      return;
    }
  } catch (error) {
    process.stderr.write(`[dispatchkit] ${renderError(error)}\n\n`);
    printUsage();
    process.exit(1);
  }
}

await run();
