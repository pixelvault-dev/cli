import { runCommand, runMain, type CommandDef } from "citty";
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
  }
}
