import { runCommand, runMain, type CommandDef } from "citty";
import { setCurrentCommand } from "./client.js";
import { CliError } from "./errors.js";
import { stderr } from "./output.js";

/**
 * Entry point wrapper around citty.
 *
 * citty's `runMain` swallows every error itself: for anything that isn't its own
 * usage error it prints the error WITH a stack trace, prints the message a second
 * time, and always exits 1 — so a `CliError` printed twice with a stack and its
 * `exitCode` was ignored (and the `.catch` after `runMain` never ran). We hand
 * `--help` / `--version` to `runMain` (it renders those well) and run everything
 * else through `runCommand` so we own error output.
 */
export async function runCli(
  main: CommandDef,
  rawArgs: string[] = process.argv.slice(2),
  exit: (code: number) => void = (code) => process.exit(code)
): Promise<void> {
  const wantsMeta =
    rawArgs.includes("--help") ||
    rawArgs.includes("-h") ||
    (rawArgs.length === 1 && rawArgs[0] === "--version");
  if (wantsMeta) {
    await runMain(main, { rawArgs });
    return;
  }

  setCurrentCommand(await resolveSubCommand(main, rawArgs));
  try {
    await runCommand(main, { rawArgs });
  } catch (err) {
    if (err instanceof CliError) {
      stderr(`Error: ${err.message}`);
      exit(err.exitCode);
      return;
    }
    // citty's own usage errors (missing argument, unknown command) surface before
    // any command body runs, so replaying through runMain is side-effect free and
    // gets citty's usage rendering.
    if (err instanceof Error && err.name === "CLIError") {
      await runMain(main, { rawArgs });
      return;
    }
    stderr(`Error: ${err instanceof Error ? err.message : String(err)}`);
    exit(1);
  } finally {
    setCurrentCommand(undefined);
  }
}

/**
 * The top-level subcommand `rawArgs` selects, resolved the way citty does (the first
 * token not starting with "-"), or undefined when there is none or it is not a
 * declared subcommand (citty then reports it as unknown).
 */
async function resolveSubCommand(main: CommandDef, rawArgs: string[]): Promise<string | undefined> {
  const name = rawArgs.find((arg) => !arg.startsWith("-"));
  if (!name) return undefined;
  const defs = typeof main.subCommands === "function" ? await main.subCommands() : await main.subCommands;
  return defs && Object.hasOwn(defs, name) ? name : undefined;
}
