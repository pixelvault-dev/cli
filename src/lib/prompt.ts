import { createInterface } from "node:readline";

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
