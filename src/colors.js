// Shared ANSI colour helpers
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const RED = '\x1b[31m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const CYAN = '\x1b[36m';

export function bold(s) { return `${BOLD}${s}${RESET}`; }
export function dim(s) { return `${DIM}${s}${RESET}`; }
export function red(s) { return `${RED}${s}${RESET}`; }
export function green(s) { return `${GREEN}${s}${RESET}`; }
export function yellow(s) { return `${YELLOW}${s}${RESET}`; }
export function cyan(s) { return `${CYAN}${s}${RESET}`; }
