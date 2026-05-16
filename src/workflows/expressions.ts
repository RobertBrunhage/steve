// Sandboxed shell-ish expression evaluator. Pratt-style recursive descent.
//
// Used for `when:`, `condition:`, `wait.until:`, and string interpolation in
// `${...}` segments. NEVER eval/Function/with — only walks own properties of
// the evaluation context. Missing paths return null (shell-like ergonomics).
//
// Grammar:
//   expr  ::= or
//   or    ::= and ( "||" and )*
//   and   ::= not ( "&&" not )*
//   not   ::= "!" not | comp
//   comp  ::= add ( ( "==" | "!=" | "<" | "<=" | ">" | ">=" ) add )?
//   add   ::= mul ( ( "+" | "-" ) mul )*
//   mul   ::= unary ( ( "*" | "/" | "%" ) unary )*
//   unary ::= "-" unary | primary
//   primary ::= number | string | "true" | "false" | "null"
//             | path | "(" expr ")" | call
//   path  ::= "$" ident ( "." ident | "[" expr "]" )*
//   call  ::= ident "(" args? ")"      // allowlist only

import type { EvalContext } from "./types.js";

type Token =
  | { type: "num"; value: number; pos: number }
  | { type: "str"; value: string; pos: number }
  | { type: "ident"; value: string; pos: number }
  | { type: "op"; value: string; pos: number }
  | { type: "punct"; value: string; pos: number }
  | { type: "eof"; pos: number };

const ALLOWED_FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  length: (args) => Array.isArray(args[0]) ? args[0].length : typeof args[0] === "string" ? args[0].length : 0,
  len: (args) => Array.isArray(args[0]) ? args[0].length : typeof args[0] === "string" ? args[0].length : 0,
  lower: (args) => typeof args[0] === "string" ? args[0].toLowerCase() : "",
  upper: (args) => typeof args[0] === "string" ? args[0].toUpperCase() : "",
  contains: (args) => typeof args[0] === "string" && typeof args[1] === "string" ? args[0].includes(args[1]) : false,
  startsWith: (args) => typeof args[0] === "string" && typeof args[1] === "string" ? args[0].startsWith(args[1]) : false,
  endsWith: (args) => typeof args[0] === "string" && typeof args[1] === "string" ? args[0].endsWith(args[1]) : false,
  not: (args) => !coerceBool(args[0]),
};

export class EvalError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.pos = pos;
  }
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
      tokens.push({ type: "num", value: Number(src.slice(i, j)), pos: i });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < src.length) {
          value += src[j + 1];
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      if (src[j] !== quote) throw new EvalError("unterminated string", i);
      tokens.push({ type: "str", value, pos: i });
      i = j + 1;
      continue;
    }
    if (c === "$" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i;
      if (src[j] === "$") j++;
      while (j < src.length && ((src[j] >= "a" && src[j] <= "z") || (src[j] >= "A" && src[j] <= "Z") || (src[j] >= "0" && src[j] <= "9") || src[j] === "_")) j++;
      tokens.push({ type: "ident", value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    // Two-character operators first
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "&&" || two === "||") {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if ("+-*/%<>!".includes(c)) {
      tokens.push({ type: "op", value: c, pos: i });
      i++;
      continue;
    }
    if ("()[],.".includes(c)) {
      tokens.push({ type: "punct", value: c, pos: i });
      i++;
      continue;
    }
    throw new EvalError(`unexpected character '${c}'`, i);
  }
  tokens.push({ type: "eof", pos: src.length });
  return tokens;
}

export function coerceBool(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0 && value !== "false" && value !== "0";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return false;
}

function isEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "number" && typeof b === "string" && /^-?\d+(\.\d+)?$/.test(b)) return a === Number(b);
  if (typeof b === "number" && typeof a === "string" && /^-?\d+(\.\d+)?$/.test(a)) return Number(a) === b;
  return false;
}

function compare(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "number" && typeof b === "string") {
    const nb = Number(b);
    if (!Number.isNaN(nb)) return a < nb ? -1 : a > nb ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "number") {
    const na = Number(a);
    if (!Number.isNaN(na)) return na < b ? -1 : na > b ? 1 : 0;
  }
  return null;
}

function readPath(tokens: Token[], idx: number, ctx: EvalContext): { value: unknown; idx: number } {
  const head = tokens[idx];
  if (head.type !== "ident" || !head.value.startsWith("$")) {
    throw new EvalError("expected path", head.pos);
  }
  const root = head.value.slice(1);
  let current: unknown;
  if (root === "steps") current = ctx.steps;
  else if (root === "args") current = ctx.args;
  else if (root === "env") current = ctx.env || {};
  else if (root === "loop") current = ctx.loop || {};
  else current = (ctx as unknown as Record<string, unknown>)[root] ?? null;
  let i = idx + 1;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === "punct" && tok.value === ".") {
      const next = tokens[i + 1];
      if (!next || next.type !== "ident") throw new EvalError("expected identifier after '.'", tok.pos);
      if (current && typeof current === "object" && !Array.isArray(current) && Object.prototype.hasOwnProperty.call(current, next.value)) {
        current = (current as Record<string, unknown>)[next.value];
      } else {
        current = null;
      }
      i += 2;
      continue;
    }
    if (tok.type === "punct" && tok.value === "[") {
      const { value: indexValue, idx: nextIdx } = parseExpr(tokens, i + 1, ctx);
      const close = tokens[nextIdx];
      if (!close || close.type !== "punct" || close.value !== "]") throw new EvalError("expected ']'", tok.pos);
      if (typeof indexValue === "number" && Array.isArray(current)) {
        current = current[indexValue] ?? null;
      } else if (typeof indexValue === "string" && current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, indexValue)) {
        current = (current as Record<string, unknown>)[indexValue];
      } else {
        current = null;
      }
      i = nextIdx + 1;
      continue;
    }
    break;
  }
  return { value: current, idx: i };
}

function parsePrimary(tokens: Token[], idx: number, ctx: EvalContext): { value: unknown; idx: number } {
  const tok = tokens[idx];
  if (tok.type === "num") return { value: tok.value, idx: idx + 1 };
  if (tok.type === "str") return { value: tok.value, idx: idx + 1 };
  if (tok.type === "ident") {
    if (tok.value === "true") return { value: true, idx: idx + 1 };
    if (tok.value === "false") return { value: false, idx: idx + 1 };
    if (tok.value === "null") return { value: null, idx: idx + 1 };
    if (tok.value.startsWith("$")) return readPath(tokens, idx, ctx);
    // function call
    const next = tokens[idx + 1];
    if (next && next.type === "punct" && next.value === "(") {
      const fn = ALLOWED_FUNCTIONS[tok.value];
      if (!fn) throw new EvalError(`unknown function '${tok.value}'`, tok.pos);
      const args: unknown[] = [];
      let i = idx + 2;
      const peek = tokens[i];
      if (!(peek.type === "punct" && peek.value === ")")) {
        while (true) {
          const { value, idx: nextIdx } = parseExpr(tokens, i, ctx);
          args.push(value);
          i = nextIdx;
          const sep = tokens[i];
          if (sep.type === "punct" && sep.value === ",") { i++; continue; }
          break;
        }
      }
      const close = tokens[i];
      if (!close || close.type !== "punct" || close.value !== ")") throw new EvalError("expected ')'", tok.pos);
      return { value: fn(args), idx: i + 1 };
    }
    throw new EvalError(`unknown identifier '${tok.value}'`, tok.pos);
  }
  if (tok.type === "punct" && tok.value === "(") {
    const inner = parseExpr(tokens, idx + 1, ctx);
    const close = tokens[inner.idx];
    if (!close || close.type !== "punct" || close.value !== ")") throw new EvalError("expected ')'", tok.pos);
    return { value: inner.value, idx: inner.idx + 1 };
  }
  throw new EvalError(`unexpected token '${"value" in tok ? tok.value : tok.type}'`, tok.pos);
}

function parseUnary(tokens: Token[], idx: number, ctx: EvalContext): { value: unknown; idx: number } {
  const tok = tokens[idx];
  if (tok.type === "op" && tok.value === "-") {
    const { value, idx: nextIdx } = parseUnary(tokens, idx + 1, ctx);
    return { value: typeof value === "number" ? -value : null, idx: nextIdx };
  }
  if (tok.type === "op" && tok.value === "!") {
    const { value, idx: nextIdx } = parseUnary(tokens, idx + 1, ctx);
    return { value: !coerceBool(value), idx: nextIdx };
  }
  return parsePrimary(tokens, idx, ctx);
}

function parseMul(tokens: Token[], idx: number, ctx: EvalContext): { value: unknown; idx: number } {
  let { value, idx: i } = parseUnary(tokens, idx, ctx);
  while (true) {
    const tok = tokens[i];
    if (tok.type !== "op" || (tok.value !== "*" && tok.value !== "/" && tok.value !== "%")) break;
    const right = parseUnary(tokens, i + 1, ctx);
    if (typeof value !== "number" || typeof right.value !== "number") { value = null; }
    else if (tok.value === "*") value = value * right.value;
    else if (tok.value === "/") value = right.value === 0 ? null : value / right.value;
    else value = right.value === 0 ? null : value % right.value;
    i = right.idx;
  }
  return { value, idx: i };
}

function parseAdd(tokens: Token[], idx: number, ctx: EvalContext): { value: unknown; idx: number } {
  let { value, idx: i } = parseMul(tokens, idx, ctx);
  while (true) {
    const tok = tokens[i];
    if (tok.type !== "op" || (tok.value !== "+" && tok.value !== "-")) break;
    const right = parseMul(tokens, i + 1, ctx);
    if (tok.value === "+" && (typeof value === "string" || typeof right.value === "string")) {
      value = String(value ?? "") + String(right.value ?? "");
    } else if (typeof value === "number" && typeof right.value === "number") {
      value = tok.value === "+" ? value + right.value : value - right.value;
    } else {
      value = null;
    }
    i = right.idx;
  }
  return { value, idx: i };
}

function parseComp(tokens: Token[], idx: number, ctx: EvalContext): { value: unknown; idx: number } {
  const left = parseAdd(tokens, idx, ctx);
  const tok = tokens[left.idx];
  if (tok.type === "op" && (tok.value === "==" || tok.value === "!=" || tok.value === "<" || tok.value === "<=" || tok.value === ">" || tok.value === ">=")) {
    const right = parseAdd(tokens, left.idx + 1, ctx);
    let value: unknown;
    if (tok.value === "==") value = isEq(left.value, right.value);
    else if (tok.value === "!=") value = !isEq(left.value, right.value);
    else {
      const cmp = compare(left.value, right.value);
      if (cmp === null) value = false;
      else if (tok.value === "<") value = cmp < 0;
      else if (tok.value === "<=") value = cmp <= 0;
      else if (tok.value === ">") value = cmp > 0;
      else value = cmp >= 0;
    }
    return { value, idx: right.idx };
  }
  return left;
}

function parseAnd(tokens: Token[], idx: number, ctx: EvalContext): { value: unknown; idx: number } {
  let { value, idx: i } = parseComp(tokens, idx, ctx);
  while (true) {
    const tok = tokens[i];
    if (tok.type !== "op" || tok.value !== "&&") break;
    const right = parseComp(tokens, i + 1, ctx);
    value = coerceBool(value) && coerceBool(right.value);
    i = right.idx;
  }
  return { value, idx: i };
}

function parseExpr(tokens: Token[], idx: number, ctx: EvalContext): { value: unknown; idx: number } {
  let { value, idx: i } = parseAnd(tokens, idx, ctx);
  while (true) {
    const tok = tokens[i];
    if (tok.type !== "op" || tok.value !== "||") break;
    const right = parseAnd(tokens, i + 1, ctx);
    value = coerceBool(value) ? value : right.value;
    i = right.idx;
  }
  return { value, idx: i };
}

export function evaluate(expr: string, ctx: EvalContext): unknown {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  const tokens = tokenize(trimmed);
  const { value, idx } = parseExpr(tokens, 0, ctx);
  if (tokens[idx].type !== "eof") {
    throw new EvalError(`unexpected trailing tokens at position ${tokens[idx].pos}`, tokens[idx].pos);
  }
  return value;
}

/**
 * Interpolate `${expr}` segments inside a string. `$path.dots` outside of
 * `${...}` is left literal. Errors evaluate to empty string.
 */
export function interpolate(template: string, ctx: EvalContext): string {
  let result = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "$" && template[i + 1] === "{") {
      const end = template.indexOf("}", i + 2);
      if (end === -1) { result += template.slice(i); break; }
      const expr = template.slice(i + 2, end);
      try {
        const value = evaluate(expr, ctx);
        result += value === null || value === undefined ? "" : String(value);
      } catch {
        result += "";
      }
      i = end + 1;
      continue;
    }
    result += template[i];
    i++;
  }
  return result;
}
