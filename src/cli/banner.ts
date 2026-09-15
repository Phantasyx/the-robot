/** Branded CLI banner for The Robot. */

export const PRODUCT_NAME = 'The Robot';
export const BIN_NAMES = ['the-robot', 'robot'] as const;

export function banner(version = '0.1.0'): string {
  return [
    '',
    `  ╭──────────────────────────╮`,
    `  │  ${PRODUCT_NAME.padEnd(24)}│`,
    `  │  offline agent runtime   │`,
    `  │  v${version.padEnd(22)}│`,
    `  ╰──────────────────────────╯`,
    '',
  ].join('\n');
}

export function helpText(): string {
  return `${banner()}Usage:
  robot <command> [options]

Commands:
  run [prompt]       Run an agent session (use --dry-run without a model)
  skills list        List installed skill packs
  routines list      List routine configs
  doctor             Check local provider / env
  help               Show this help

Options:
  --dry-run          Plan and print steps without calling a model or tools
  --skill <name>     Prefer a specific skill pack
  --routine <name>   Seed the session from a routine
  --max-steps <n>    Cap dry-run / loop iterations (default: 5)
  -h, --help         Show help

Examples:
  robot run --dry-run "summarize notes in ./notes"
  robot skills list
  robot routines list
  robot doctor

Environment:
  ROBOT_PROVIDER          ollama (default)
  ROBOT_OLLAMA_HOST       http://127.0.0.1:11434
  ROBOT_MODEL             llama3.2
  ROBOT_APPROVAL_MODE     prompt | auto-approve | deny
`;
}
