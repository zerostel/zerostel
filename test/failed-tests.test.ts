import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleHook } from '../src/agents/hooks.js';
import { renderChecks } from '../src/commands/checks.js';
import { failedTests, failedText } from '../src/commands/failed-tests.js';
import { renderHandoff } from '../src/commands/handoff.js';
import { handleMessage } from '../src/mcp/server.js';
import { openProject } from '../src/store/project.js';
import { findSession, loadSession } from '../src/store/session.js';
import { snapshot } from '../src/store/shadow.js';
import { renderTimeline } from '../src/view/timeline.js';
import { sandbox, type Sandbox } from './helpers.js';

// Output as each test runner prints it when tests fail (trimmed to the parts that matter).

const VITEST = ` ❯ test/math.test.ts (3 tests | 2 failed) 12ms
   × adds > handles negatives 5ms
   ✓ multiplies 1ms
   × divides by zero 2ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/math.test.ts > adds > handles negatives
AssertionError: expected -1 to be 1
 FAIL  test/math.test.ts > divides by zero
Error: boom

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)`;

const JEST = `FAIL src/sum.test.js
  sum
    ✓ adds (2 ms)
    ✕ subtracts (3 ms)

  ● sum › subtracts

    expect(received).toBe(expected)

Tests:       1 failed, 1 passed, 2 total`;

const PYTEST = `=========================== short test summary info ============================
FAILED tests/test_api.py::test_login - AssertionError: assert 401 == 200
FAILED tests/test_api.py::TestUser::test_name[admin] - KeyError: 'name'
ERROR tests/test_db.py::test_connect - ConnectionRefusedError
ERROR tests/test_cli.py - ModuleNotFoundError: No module named 'click'
==================== 2 failed, 5 passed, 2 errors in 0.42s =====================`;

const GO = `--- FAIL: TestParse (0.00s)
    --- FAIL: TestParse/empty (0.00s)
        parse_test.go:12: got 1, want 2
--- FAIL: TestFormat (0.00s)
FAIL
FAIL	example.com/pkg	0.012s
FAIL`;

const CARGO = `running 3 tests
test tests::adds ... ok
test tests::subtracts ... FAILED
test tests::divides ... FAILED

failures:
    tests::subtracts
    tests::divides

test result: FAILED. 1 passed; 2 failed; 0 ignored`;

const TAP = `TAP version 13
ok 1 - formats
not ok 2 - parses dates
  ---
  duration_ms: 1.2
  ...
not ok 3 - not written yet # TODO
not ok 4 - flaky one # SKIP
1..4`;

describe('which tests failed', () => {
  it('reads the names from vitest, jest, pytest, go test, cargo test and TAP output', () => {
    expect(failedTests(VITEST)).toEqual(['test/math.test.ts > adds > handles negatives', 'test/math.test.ts > divides by zero']);
    expect(failedTests(JEST)).toEqual(['sum › subtracts']);
    expect(failedTests(PYTEST)).toEqual(['tests/test_api.py::test_login', 'tests/test_api.py::TestUser::test_name[admin]', 'tests/test_db.py::test_connect', 'tests/test_cli.py']);
    expect(failedTests(GO)).toEqual(['TestParse/empty', 'TestFormat']);
    expect(failedTests(CARGO)).toEqual(['tests::subtracts', 'tests::divides']);
    // to-do and skipped tests aren't failures
    expect(failedTests(TAP)).toEqual(['parses dates']);
  });

  it('reads node --test, dotnet test, rspec and Gradle too, and a whole file when no test is named', () => {
    expect(failedTests('✔ formats (0.4ms)\n✖ parses dates (1.2ms)\n')).toEqual(['parses dates']);
    expect(failedTests('  Passed MyApp.Tests.CalcTests.Adds [1 ms]\n  Failed MyApp.Tests.CalcTests.Divides [12 ms]\n  Error Message:\n')).toEqual(['MyApp.Tests.CalcTests.Divides']);
    expect(failedTests('Failed examples:\n\nrspec ./spec/calc_spec.rb:5 # Calc adds numbers\n')).toEqual(['Calc adds numbers']);
    expect(failedTests('CalcTest > adds() PASSED\nCalcTest > divides() FAILED\n    AssertionFailedError at CalcTest.java:10\n')).toEqual(['CalcTest > divides()']);
    // jest when a file can't even load: the file is all there is to name
    expect(failedTests('FAIL src/broken.test.js\n  ● Test suite failed to run\n\n    SyntaxError: Unexpected token\n')).toEqual(['src/broken.test.js']);
  });

  it('names nothing when nothing failed or the output says nothing about tests', () => {
    expect(failedTests(undefined)).toEqual([]);
    expect(failedTests('')).toEqual([]);
    expect(failedTests(' Test Files  3 passed (3)\n      Tests  12 passed (12)')).toEqual([]);
    expect(failedTests('npm ERR! code ELIFECYCLE\nnpm ERR! errno 1')).toEqual([]);
  });

  it('skips the first line of a tail cut from a longer output: it starts in the middle', () => {
    expect(failedTests('…_api.py::test_cut - E\nFAILED tests/test_a.py::test_b - E')).toEqual(['tests/test_a.py::test_b']);
  });

  it('keeps terminal escapes, control and direction characters out of the names', () => {
    expect(failedTests('\x1b[31m   × \x1b[39mfails in red\x1b[0m 3ms')).toEqual(['fails in red']);
    // a link escape (OSC 8) is dropped, its text kept
    expect(failedTests('FAILED tests/t.py::\x1b]8;;https://evil.example\x07test_x\x1b]8;;\x07 - E')).toEqual(['tests/t.py::test_x']);
    const [name] = failedTests('FAILED tests/t.py::test_‮evil\x07\x00 - E');
    expect(name).toBe('tests/t.py::test_evil');
    expect(name).not.toMatch(/[\x00-\x1f‮]/);
  });

  it('stays short: at most 20 names of at most 120 characters, and very long lines are skipped', () => {
    const many = Array.from({ length: 30 }, (_, i) => `--- FAIL: Test${i} (0.00s)`).join('\n');
    expect(failedTests(many)).toHaveLength(20);
    expect(failedText(failedTests(many))).toMatch(/^20\+ failed: Test0, Test1, Test2, Test3, Test4 \(\+15 more\)$/);
    expect(failedTests(`--- FAIL: Test${'x'.repeat(300)} (0.00s)`)[0]).toHaveLength(120);
    expect(failedTests(`   × ${'a'.repeat(600)} 3ms`)).toEqual([]);
  });

  it('takes no noticeable time on output built to make a pattern backtrack', () => {
    const nasty = [`   × ${' 1'.repeat(240)}`, `rspec ${'# '.repeat(240)}`, `FAIL ${' > '.repeat(160)}`, `x ${' > x'.repeat(120)} FAILED!`].join('\n').repeat(4);
    const started = performance.now();
    failedTests(nasty);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('says how many failed and names a few', () => {
    expect(failedText(['a'])).toBe('1 failed: a');
    expect(failedText(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3)).toBe('7 failed: a, b, c (+4 more)');
  });
});

describe('failed tests in checks, the log, the MCP server and handoffs', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = sandbox();
    sb.write('tests/test_api.py', 'def test_login(): assert False\n');
  });
  afterEach(() => sb.cleanup());

  const ev = (e: Record<string, unknown>) => handleHook('claude-code', { session_id: 'f1', cwd: sb.project, ...e }, sb.ctx);
  function run(command: string, stdout: string, fail: boolean) {
    ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: command, tool_input: { command } });
    ev({ hook_event_name: fail ? 'PostToolUseFailure' : 'PostToolUse', tool_name: 'Bash', tool_use_id: command, tool_input: { command }, tool_response: fail ? { stdout, error: 'Exit code 1' } : { stdout } });
  }

  it('names the failed tests where the agent looks, and only counts them in a handoff', () => {
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the login' });
    run('python -m pytest -q', PYTEST, true);
    ev({ hook_event_name: 'Stop' });
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    const current = snapshot(p, 'now').sha;

    const checks = renderChecks(p, s, current).join('\n');
    expect(checks).toContain('4 failed: tests/test_api.py::test_login, tests/test_api.py::TestUser::test_name[admin]');

    const log = renderTimeline(s, { width: 140 }).join('\n');
    expect(log).toContain('4 failed: tests/test_api.py::test_login');

    const mcp = handleMessage(sb.ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'checks', arguments: {} } }) as { result: { content: { text: string }[] } };
    expect(mcp.result.content[0]!.text).toContain('tests/test_api.py::test_login');

    // a handoff copies no tool output: it says how many, and where to look
    const handoff = renderHandoff(p, s, current, { version: 'test' });
    expect(handoff).toContain('FAILED (4 tests; `zerostel checks` names them)');
    expect(handoff).not.toContain('test_login');
  });

  it('names nothing for a check that passed, even if its output mentions a failure', () => {
    ev({ hook_event_name: 'UserPromptSubmit', prompt: 'run the tests' });
    run('python -m pytest -q', 'FAILED tests/test_api.py::test_old - this line is from a log the test prints\n1 passed', false);
    const p = openProject(sb.project, sb.ctx);
    const s = loadSession(findSession(p)!);
    expect(renderChecks(p, s, null).join('\n')).not.toContain('failed:');
  });
});
