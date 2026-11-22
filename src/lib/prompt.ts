import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/**
 * Prompt the user for input via stderr (keeps stdout clean for agents).
 */
export function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Read one line from a non-interactive input (default stdin), for flags like
 * `--password-stdin`. The line is returned verbatim (no trimming) without its
 * line ending; an input that ends before any line yields "".
 *
 * Consumes the input: it is destroyed after the first line, so a pipe whose
 * writer stays open cannot keep the CLI alive after the request finishes.
 */
export function readLine(input: Readable = process.stdin): Promise<string> {
  // Executor form: Promise.withResolvers needs Node 22 and the CLI supports Node 20.
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, terminal: false });
    let done = false;
    const settle = (error: Error | null, line = "") => {
      if (done) return;
      done = true;
      input.removeListener("error", settle);
      rl.close();
      input.destroy();
      if (error) reject(error);
      else resolve(line);
    };
    input.once("error", settle);
    rl.once("line", (line) => settle(null, line));
    rl.once("close", () => settle(null));
  });
}

/**
 * Prompt for a password (input is not echoed).
 * Uses raw mode to suppress echo when available, falls back to regular prompt.
 */
export async function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return prompt(question);
  }

  return new Promise((resolve) => {
    process.stderr.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    let password = "";

    const onData = (char: string) => {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stderr.write("\n");
        resolve(password);
      } else if (char === "\u0003") {
        // Ctrl+C
        process.stdin.setRawMode(false);
        process.exit(130);
      } else if (
        char === "\u007F" ||
        char === "\b"
      ) {
        // Backspace
        password = password.slice(0, -1);
      } else {
        password += char;
      }
    };

    process.stdin.on("data", onData);
  });
}
