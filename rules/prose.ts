#!/usr/bin/env node
// Holds commentary to a prose rule: at most 2 comment lines for a function or type, its doc
// and the comments in its body together, and at most 30 lines in a Markdown file. It reads every
// tracked file, or those named, bar the prefixes given to --ignore.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/** The comment lines a function or type may have, and the lines a Markdown file may. */
export const COMMENT_LINES = 2;
export const MARKDOWN_LINES = 30;

/** How a language marks its comments, the lines that open a function's body, and the comment
 *  lines its own tools need, which say nothing to a reader. */
interface Language {
  readonly comment: RegExp;
  readonly blockOpen: RegExp;
  readonly blockClose: RegExp;
  readonly opens: RegExp;
  readonly needed: RegExp;
}

/** A pattern that matches nothing, for a language with no block comments. */
const NEVER = /(?!)/u;

const slashed = (opens: RegExp, needed = NEVER): Language => ({
  comment: /^\s*\/\//u,
  blockOpen: /^\s*\/\*/u,
  blockClose: /\*\//u,
  opens,
  needed,
});

/** Rustdoc's headings that clippy asks for: a function's errors, panics and safety. */
const RUST_HEADINGS = /^\s*\/\/[/!]\s*#\s+(?:Errors|Panics|Safety)\s*$/u;

/** A JSDoc tag that gives plain JavaScript its types, as TypeScript reads them: a type and its
 *  name alone, or an import. */
const JS_TYPE_TAG =
  /^\s*(?:\/\*\*|\*)\s*@(?:import\b.*|(?:type|returns?|satisfies|this|enum)\s*\{.*\}|(?:param|property|typedef|callback|template)\b\s*(?:\{.*\})?\s*\[?[\w$.]+(?:=[^\]]*)?\]?)\s*(?:\*\/)?\s*$/u;

const TS_OPENS =
  /\bfunction\b.*\{\s*$|=>\s*\{\s*$|^\s*(?!(?:if|for|while|switch|catch|with|return)\b)(?:(?:async|static|public|private|protected|get|set)\s+)*\w+\s*\([^)]*\)[^=]*\{\s*$/u;

const LANGUAGES: Readonly<Record<string, Language>> = {
  ts: slashed(TS_OPENS),
  js: slashed(TS_OPENS, JS_TYPE_TAG),
  swift: slashed(/\b(?:func|init|deinit|subscript)\b.*\{\s*$|\bvar\b[^=]*\{\s*$/u),
  rs: slashed(/\bfn\b.*\{\s*$/u, RUST_HEADINGS),
  sh: {
    comment: /^\s*#/u,
    blockOpen: NEVER,
    blockClose: NEVER,
    opens: /^\s*(?:function\s+)?[\w-]+\s*(?:\(\))?\s*\{\s*$/u,
    needed: NEVER,
  },
  py: {
    comment: /^\s*#/u,
    blockOpen: /^\s*[rRuU]?(?:"{3}|'{3})/u,
    blockClose: /"{3}|'{3}/u,
    opens: /^\s*(?:async\s+)?(?:def|class)\b/u,
    needed: NEVER,
  },
};

const KINDS: Readonly<Record<string, string>> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.mjs': 'js',
  '.js': 'js',
  '.cjs': 'js',
  '.swift': 'swift',
  '.rs': 'rs',
  '.sh': 'sh',
  '.py': 'py',
};

/** A function or type being counted: its first line, where it ends, and its comment lines. */
interface Counted {
  readonly line: number;
  readonly depth: number;
  comments: number;
}

/** A file being read: its language and findings, the bodies open around the line, the comment
 *  lines waiting for what they document, the depths of braces and brackets, and the last line. */
interface Reading {
  readonly name: string;
  readonly language: Language;
  readonly findings: string[];
  readonly open: Counted[];
  waiting: { line: number; comments: number };
  depth: number;
  parens: number;
  inBlock: boolean;
  afterCode: boolean;
  seenCode: boolean;
}

const readingOf = (name: string, language: Language): Reading => ({
  name,
  language,
  findings: [],
  open: [],
  waiting: { line: 0, comments: 0 },
  depth: 0,
  parens: 0,
  inBlock: false,
  afterCode: false,
  seenCode: false,
});

/** A regular expression's literal, which follows an operator or a bracket, never a name. */
const REGEX_LITERAL =
  /(?<=(?:^|[=(,:!&|?{};[])\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\n\\[])+\/[dgimsuyv]*/gu;

/** A line's code with its strings and a trailing comment taken out, so its brackets can be counted. */
const codeOf = (text: string): string =>
  text
    .replaceAll(REGEX_LITERAL, '/r/')
    .replaceAll(/(?<quote>["'`])(?:\\.|(?!\k<quote>).)*\k<quote>/gu, '""')
    .replace(/\s\/\/.*$/u, '')
    .replace(/\s#.*$/u, '');

const balance = (code: string, opening: RegExp, closing: RegExp): number =>
  (code.match(opening) ?? []).length - (code.match(closing) ?? []).length;

const file = (reading: Reading, at: number, comments: number): void => {
  if (comments > COMMENT_LINES) {
    reading.findings.push(
      `${reading.name}:${String(at)} has ${String(comments)} comment lines, where the most is ${String(COMMENT_LINES)}`,
    );
  }
};

/** Checks the lines waiting for a declaration that has ended without a body to join; those before
 *  the file's first code are its header, the file's and not a declaration's. */
const settle = (reading: Reading): void => {
  if (reading.seenCode) {
    file(reading, reading.waiting.line, reading.waiting.comments);
  }
  reading.waiting = { line: 0, comments: 0 };
};

/** Whether a line is a comment, carrying a block comment from line to line. */
const isComment = (reading: Reading, text: string): boolean => {
  const { blockOpen, blockClose, comment } = reading.language;
  if (reading.inBlock) {
    reading.inBlock = !blockClose.test(text);
    return true;
  }
  if (blockOpen.test(text)) {
    reading.inBlock = !blockClose.test(text.replace(blockOpen, ''));
    return true;
  }
  return comment.test(text);
};

/** A comment's delimiter alone on its line, or an empty line in a comment, such as the one
 *  Ruff's D205 puts after a docstring's summary. */
const DELIMITER = /^\s*(?:\/\*\*?|\*\/|\*|\/\/[/!]?|#|[rRuU]?"{3}|[rRuU]?'{3})?\s*$/u;

/** A whole-line directive to a linter or spell checker. */
const DIRECTIVE =
  /^\s*(?:\/\/|\/\*|\*|#)\s*(?:cspell:|(?:oxlint|eslint)-(?:disable|enable)|swiftlint:(?:disable|enable)|(?:ruff:\s*)?noqa\b|shellcheck\s)/u;

/** A comment line counts for the body around it, or waits for the declaration it documents. One
 *  that says nothing to a reader counts for neither. */
const commented = (reading: Reading, at: number, text: string): void => {
  if (DELIMITER.test(text) || DIRECTIVE.test(text) || reading.language.needed.test(text)) {
    return;
  }
  const inner = reading.open.at(-1);
  if (inner !== undefined) {
    inner.comments += 1;
    return;
  }
  if (reading.afterCode) {
    settle(reading);
  }
  const line = reading.waiting.comments === 0 ? at : reading.waiting.line;
  reading.waiting = { line, comments: reading.waiting.comments + 1 };
};

/** Opens a function's or type's body, which takes the lines waiting for it as its own. */
const openBody = (reading: Reading, at: number): void => {
  const outside = reading.open.length === 0;
  const { line, comments } = reading.waiting;
  reading.open.push({
    line: outside && comments > 0 ? line : at,
    depth: reading.depth,
    comments: outside ? comments : 0,
  });
  reading.waiting = { line: 0, comments: 0 };
};

/** Checks each body the reading has left. */
const closeBodies = (reading: Reading): void => {
  const inner = reading.open.at(-1);
  if (inner !== undefined && inner.depth >= reading.depth) {
    reading.open.pop();
    file(reading, inner.line, inner.comments);
    closeBodies(reading);
  }
};

/** A file's imports, whose header comment documents the file, not a function or type. Swift's
 *  and Rust's may carry an attribute and an access level. */
const IMPORT =
  /^\s*(?:@\w+\s+)*(?:(?:public|package|internal|fileprivate|private|pub(?:\([^)]*\))?)\s+)?(?:import|use|from|export\s+\*|export\s+\{[^}]*\}\s+from)\b/u;

/** A line of code: one that opens a function's body counts the waiting lines as its own, and one
 *  that ends a declaration checks them. */
const coded = (reading: Reading, text: string, at: number): void => {
  const code = codeOf(text);
  if (IMPORT.test(code)) {
    reading.waiting = { line: 0, comments: 0 };
  } else if (reading.language.opens.test(code)) {
    openBody(reading, at);
  } else if (reading.open.length === 0 && reading.parens === 0 && /[;,{}]\s*$/u.test(code)) {
    settle(reading);
  }
  reading.parens += balance(code, /[([]/gu, /[)\]]/gu);
  reading.depth += balance(code, /\{/gu, /\}/gu);
  reading.seenCode = true;
  closeBodies(reading);
};

/** The findings for one file in a language with braces. */
const braced = (reading: Reading, lines: readonly string[]): string[] => {
  for (const [index, text] of lines.entries()) {
    const comment = isComment(reading, text);
    if (comment) {
      commented(reading, index + 1, text);
    } else if (text.trim() === '') {
      settle(reading);
    } else {
      coded(reading, text, index + 1);
    }
    reading.afterCode = !comment && text.trim() !== '';
  }
  settle(reading);
  return reading.findings;
};

/** A Python line: its indent closes the bodies it has left, and a docstring or comment counts for
 *  the body around it, or waits for the `def` or `class` it documents. */
const pythonLine = (reading: Reading, text: string, at: number): void => {
  if (!reading.inBlock) {
    reading.depth = text.length - text.trimStart().length;
    closeBodies(reading);
  }
  const comment = isComment(reading, text);
  if (comment) {
    commented(reading, at, text);
  } else if (reading.language.opens.test(text)) {
    openBody(reading, at);
  } else if (reading.open.length === 0) {
    settle(reading);
  }
  reading.afterCode = !comment;
  reading.seenCode ||= !comment;
};

/** The findings for one Python file, whose bodies are its indents. */
const indented = (reading: Reading, lines: readonly string[]): string[] => {
  for (const [index, text] of lines.entries()) {
    if (text.trim() !== '' || reading.inBlock) {
      pythonLine(reading, text, index + 1);
    }
  }
  reading.depth = -1;
  closeBodies(reading);
  settle(reading);
  return reading.findings;
};

/** Each function or type in `text` with more comment lines than the rule allows, by its kind. */
export const commentFindings = (name: string, kind: string, text: string): string[] => {
  const language = LANGUAGES[kind];
  if (language === undefined) {
    return [];
  }
  // A shebang names the file's interpreter: neither code nor a comment, so a header may follow.
  const lines = text
    .split('\n')
    .map((line, index) => (index === 0 && line.startsWith('#!') ? '' : line));
  const reading = readingOf(name, language);
  return kind === 'py' ? indented(reading, lines) : braced(reading, lines);
};

/** A Markdown file longer than the rule allows. */
export const markdownFindings = (name: string, text: string): string[] => {
  const lines = text.trimEnd().split('\n').length;
  return lines > MARKDOWN_LINES
    ? [`${name} has ${String(lines)} lines, where the most is ${String(MARKDOWN_LINES)}`]
    : [];
};

const findingsOf = (name: string): string[] => {
  const extension = path.extname(name);
  if (extension === '.md') {
    return markdownFindings(name, readFileSync(name, 'utf8'));
  }
  const kind = KINDS[extension];
  return kind === undefined ? [] : commentFindings(name, kind, readFileSync(name, 'utf8'));
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { ignore: { type: 'string', multiple: true, default: [] } },
    allowPositionals: true,
  });
  const named =
    positionals.length === 0
      ? execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
      : positionals;
  const names = named.filter(
    (name) => name !== '' && !values.ignore.some((prefix) => name.startsWith(prefix)),
  );
  const findings = names.flatMap((name) => findingsOf(name));
  for (const finding of findings) {
    console.error(finding);
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(`kit-prose: ${String(names.length)} files hold the prose rule`);
  }
}
