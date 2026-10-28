import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineCommand } from "citty";
import { runCli } from "../../src/lib/run.js";
import { CliError } from "../../src/lib/errors.js";

const makeMain = (run: () => unknown) =>
  defineCommand({
    meta: { name: "t", version: "1.2.3", description: "t" },
    subCommands: {
      boom: defineCommand({ meta: { name: "boom" }, run }),
      needs: defineCommand({
        meta: { name: "needs" },
        args: { plan: { type: "positional", required: true } },
        run() {},
      }),
    },
  });

describe("runCli", () => {
  let err = "";
  let out = "";

  beforeEach(() => {
    err = "";
    out = "";
    vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      err += s;
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      out += s;
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("prints a CliError once, without a stack trace, and exits with its exitCode", async () => {
    const exit = vi.fn();
    await runCli(
      makeMain(() => {
        throw new CliError("nope", 3);
      }),
      ["boom"],
      exit
    );
    expect(err).toBe("Error: nope\n");
    expect(err).not.toContain("    at ");
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(3);
  });

  it("reports an unexpected error as one line and exits 1", async () => {
    const exit = vi.fn();
    await runCli(
      makeMain(() => {
        throw new TypeError("kaput");
      }),
      ["boom"],
      exit
    );
    expect(err).toBe("Error: kaput\n");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not exit on success", async () => {
    const exit = vi.fn();
    await runCli(makeMain(() => {}), ["boom"], exit);
    expect(exit).not.toHaveBeenCalled();
    expect(err).toBe("");
  });

  it("does not re-run the command when it fails (no side-effect replay)", async () => {
    const run = vi.fn(() => {
      throw new CliError("x", 1);
    });
    await runCli(makeMain(run), ["boom"], vi.fn());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves citty's usage rendering for a missing argument", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await runCli(makeMain(() => {}), ["needs"], vi.fn());
    expect(exit).toHaveBeenCalledWith(1);
  });
});
