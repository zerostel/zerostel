import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { completionScript } from '../src/commands/completion.js';
import { STARTER, validate } from '../src/guard/policy.js';

describe('developer niceties', () => {
  it('prints completion scripts for every shell, listing every command', () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
      const s = completionScript(shell)!;
      for (const cmd of ['install', 'rewind', 'policy', 'verify', 'demo', 'mcp']) expect(s, shell).toContain(cmd);
    }
    expect(completionScript('tcsh')).toBeNull();
  });

  it('the published policy schema accepts the starter rules, and $schema is allowed', () => {
    const schema = JSON.parse(fs.readFileSync('site/schema/policy.json', 'utf8'));
    expect(schema.$id).toBe('https://zerostel.com/schema/policy.json');
    expect(validate({ $schema: schema.$id, ...STARTER }).problem).toBeUndefined();
    // every field a rule can have is described in the schema
    expect(Object.keys(schema.$defs.rule.properties).sort()).toEqual(['access', 'action', 'commands', 'paths', 'reason', 'tools']);
  });
});
