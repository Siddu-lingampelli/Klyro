/**
 * The default MVP task suite. All tasks are programmatic — they use a
 * scripted mock provider, so the suite is hermetic and CI-friendly.
 */

import type { ScriptedTask } from './harness.js';

export const MVP_TASKS: ScriptedTask[] = [
  {
    id: 't1-direct-answer',
    description: 'Model says hello without calling any tool.',
    task: 'say hi',
    script: [[
      { kind: 'message_start' },
      { kind: 'text_delta', text: 'Hello there.' },
      { kind: 'message_end', finishReason: 'stop' },
    ]],
    expectStatus: 'complete',
    expectToolCalls: 0,
  },
  {
    id: 't2-write-then-answer',
    description: 'Model writes a file then confirms.',
    task: 'create note.txt with content "hi"',
    script: [
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"note.txt","content":"hi"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Created.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ],
    expectStatus: 'complete',
    expectToolCalls: 1,
  },
  {
    id: 't3-policy-deny',
    description: 'Model tries to escape the cwd; policy denies.',
    task: 'escape',
    script: [
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"../escape.txt","content":"x"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'OK' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ],
    expectStatus: 'complete',
    expectToolCalls: 1,
  },
  {
    id: 't4-max-steps',
    description: 'Model never finishes; runtime returns max_steps.',
    task: 'loop forever',
    script: Array.from({ length: 15 }, () => [
      { kind: 'message_start' },
      { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
      { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"a.txt","content":"x"}' },
      { kind: 'tool_call_end', id: 'c1' },
      { kind: 'message_end', finishReason: 'tool_calls' },
    ]),
    expectStatus: 'max_steps',
    expectToolCalls: 12, // maxSteps=12 in harness, one tool call per step
  },
  {
    id: 't6-multitool',
    description: 'Model issues two tool calls in one turn.',
    task: 'create two files',
    script: [
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"a.txt","content":"1"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'tool_call_start', id: 'c2', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c2', argsJson: '{"path":"b.txt","content":"2"}' },
        { kind: 'tool_call_end', id: 'c2' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Both written.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ],
    expectStatus: 'complete',
    expectToolCalls: 2,
  },
  {
    id: 't7-write-verify-content',
    description: 'Written file bytes are exactly what the model sent (real FS assert).',
    task: 'create app.txt with content "hello eval"',
    script: [
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"app.txt","content":"hello eval"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Created.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ],
    verifyCommand: 'node -e "process.exit(require(\'fs\').readFileSync(\'app.txt\',\'utf8\')===\'hello eval\'?0:1)"',
    expectStatus: 'complete',
    expectToolCalls: 1,
  },
  {
    id: 't8-edit-flow',
    description: 'Write then edit; final bytes reflect the edit.',
    task: 'create data.txt then change its content',
    script: [
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"data.txt","content":"v1"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c2', name: 'edit_file' },
        { kind: 'tool_call_delta', id: 'c2', argsJson: '{"path":"data.txt","find":"v1","replace":"v2"}' },
        { kind: 'tool_call_end', id: 'c2' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Edited.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ],
    verifyCommand: 'node -e "process.exit(require(\'fs\').readFileSync(\'data.txt\',\'utf8\')===\'v2\'?0:1)"',
    expectStatus: 'complete',
    expectToolCalls: 2,
  },
  {
    id: 't9-allowlisted-shell',
    description: 'Allowlisted shell command executes.',
    task: 'run echo',
    script: [
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'shell_exec' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"command":"echo eval-ok"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Ran.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ],
    expectStatus: 'complete',
    expectToolCalls: 1,
  },
  {
    id: 't10-destructive-shell-denied',
    description: 'Destructive shell is denied before execution.',
    task: 'try something dangerous',
    script: [
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'shell_exec' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"command":"rm -rf /"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Understood.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ],
    expectStatus: 'complete',
    expectToolCalls: 1,
  },
  {
    id: 't11-write-read-roundtrip',
    description: 'Write then read back the same file.',
    task: 'write and read back',
    script: [
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c1', name: 'write_file' },
        { kind: 'tool_call_delta', id: 'c1', argsJson: '{"path":"round.txt","content":"roundtrip"}' },
        { kind: 'tool_call_end', id: 'c1' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'tool_call_start', id: 'c2', name: 'read_file' },
        { kind: 'tool_call_delta', id: 'c2', argsJson: '{"path":"round.txt"}' },
        { kind: 'tool_call_end', id: 'c2' },
        { kind: 'message_end', finishReason: 'tool_calls' },
      ],
      [
        { kind: 'message_start' },
        { kind: 'text_delta', text: 'Read it.' },
        { kind: 'message_end', finishReason: 'stop' },
      ],
    ],
    expectStatus: 'complete',
    expectToolCalls: 2,
  },
  {
    id: 't12-judged-answer',
    description: 'Semantic rubric example (judge runs only with a live judge adapter).',
    task: 'say done',
    script: [[
      { kind: 'message_start' },
      { kind: 'text_delta', text: 'All done.' },
      { kind: 'message_end', finishReason: 'stop' },
    ]],
    expectStatus: 'complete',
    expectToolCalls: 0,
    judge: { rubric: ['the final answer contains the word "done"'] },
  },
];
