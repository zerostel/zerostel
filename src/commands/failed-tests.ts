import { redact } from '../detect/secrets.js';
import { oneLine } from '../util/term.js';

// Which tests failed, read from the tail of a test run's output that was
// already recorded: nothing is run again. The output comes from the project
// and the agent, so whatever is taken from it loses terminal escapes and
// control characters, stays short, and is only ever shown as a name.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const MAX_FAILED = 20;

// one pattern per output format, run on one line at a time; group 1 is the name
const FAILED_LINE: RegExp[] = [
  /^\s*FAIL\s+(\S.*\s>\s.*)$/, // vitest: FAIL  test/a.test.ts > group > name
  /^\s*[×✕✗✖]\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s?m?s\)?)?$/, // vitest, jest, node --test: × name 12ms / ✕ name (5 ms) / ✖ name
  /^\s*●\s+(.*\S)$/, // jest: ● group › name
  /^(?:FAILED|ERROR)\s+(\S+::\S+)/, // pytest: FAILED tests/test_a.py::test_x - AssertionError
  /^ERROR\s+(\S+\.py)\s+-\s/, // pytest, a file that failed to load: ERROR tests/test_b.py - ImportError
  /^\s*--- FAIL:\s+(\S+)/, // go test: --- FAIL: TestX (0.00s)
  /^test\s+(\S+)\s+\.\.\.\s+FAILED$/, // cargo test: test a::x ... FAILED
  /^\s*not ok\s+\d+\s+(?:-\s+)?(.*\S)$/, // TAP, node --test: not ok 3 - name
  /^\s*Failed\s+(\S.*?)\s+\[[^\]]*\]$/, // dotnet test: Failed Ns.Class.Test [12 ms]
  /^rspec\s+\S+\s+#\s+(.*\S)$/, // rspec: rspec ./spec/a_spec.rb:12 # A does x
  /^(\S.*\s>\s.*\S)\s+FAILED$/, // gradle: ClassTest > method() FAILED
];
// a whole file that failed, used only when no single test was named
const FAILED_FILE = /^\s*FAIL\s+(\S+)/;

/**
 * The names of the tests that failed, as far as the output says: vitest,
 * jest, pytest, go test, cargo test, TAP (node --test), dotnet test, rspec
 * and Gradle. At most 20, in the order they appear, without repeats.
 */
export function failedTests(output: string | undefined): string[] {
  if (!output) return [];
  let lines = output.replace(ESCAPES, '').split(/\r?\n|\r/);
  // a tail cut from a longer output starts in the middle of a line
  if (output.startsWith('…')) lines = lines.slice(1);
  const named: string[] = [];
  const files: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(CONTROL, '');
    if (line.length > 500 || !line.trim()) continue;
    if (/^\s*not ok\b.*#\s*(?:todo|skip)\b/i.test(line)) continue;
    let name: string | undefined;
    for (const re of FAILED_LINE) {
      const m = re.exec(line);
      if (m) {
        name = m[1];
        break;
      }
    }
    if (name && !/^Test suite failed to run$/i.test(name.trim())) named.push(name.trim());
    else if (!name) {
      const f = FAILED_FILE.exec(line);
      if (f) files.push(f[1]!);
    }
  }
  const all = [...new Set(named.length ? named : files)];
  // the same test said twice, short and in full (jest: 'subtracts' and 'sum › subtracts'), or a
  // go test whose subtest failed ('TestA' and 'TestA/empty'): the more precise name stays
  const out = all.filter((n) => !all.some((m) => m !== n && (m.endsWith(` > ${n}`) || m.endsWith(` › ${n}`) || m.startsWith(`${n}/`))));
  return out.slice(0, MAX_FAILED).map((n) => (n.length > 120 ? n.slice(0, 119) + '…' : n));
}

/** "3 failed: a, b, c" for the names above, at most `max` of them. */
export function failedText(names: string[], max = 5): string {
  const shown = names.slice(0, max).map((n) => oneLine(redact(n)));
  const more = names.length > max ? ` (+${names.length - max} more)` : '';
  return `${names.length}${names.length >= MAX_FAILED ? '+' : ''} failed: ${shown.join(', ')}${more}`;
}
