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
];
