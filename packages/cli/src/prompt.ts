import readline from "node:readline/promises";

/**
 * The questions `zcms init` asks when it is run by a human.
 *
 * Deliberately dependency-free: a CLI whose job is to be installed globally and
 * to sign packages should not pull a prompt framework — and its transitive tree —
 * into that position. `node:readline/promises` asks a question and reads a line,
 * which is the whole requirement.
 *
 * Nothing here runs unless stdin is a TTY. A scaffold that blocks waiting for
 * input inside a CI job is a hang, not a prompt, so `interactive()` is the guard
 * every caller checks first.
 */

export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export interface Prompter {
  ask(question: string, fallback?: string): Promise<string>;
  choose(question: string, options: string[]): Promise<number>;
  close(): void;
}

export function createPrompter(): Prompter {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    /** Asks until an answer arrives, unless a fallback makes empty meaningful. */
    async ask(question: string, fallback?: string): Promise<string> {
      const suffix = fallback ? ` (${fallback})` : "";

      for (;;) {
        const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
        if (answer) return answer;
        if (fallback !== undefined) return fallback;
      }
    },

    /** Returns the INDEX of the chosen option. Repeats until the answer is one. */
    async choose(question: string, options: string[]): Promise<number> {
      console.log(`\n  ${question}`);
      options.forEach((option, i) => console.log(`    ${i + 1}) ${option}`));

      for (;;) {
        const answer = (await rl.question("  > ")).trim();
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < options.length) {
          return index;
        }
        console.log(`  Enter a number between 1 and ${options.length}.`);
      }
    },

    close(): void {
      rl.close();
    },
  };
}
