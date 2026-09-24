import { describe, expect, it } from 'vitest';
import { taskFinalState, vmidOfTask, type TaskLike } from '../src/tasks.js';

function task(overrides: Partial<TaskLike> & { upid: string }): TaskLike {
  return {
    node: 'pve1',
    type: 'vzdump',
    id: '100',
    user: 'root@pam',
    starttime: 1000,
    ...overrides,
  };
}

describe('vmidOfTask', () => {
  it('prefers the task\'s own id field', () => {
    expect(vmidOfTask(task({ upid: 'UPID:pve1:1:1:1:vzdump:100:root@pam:', id: '100' }))).toBe('100');
  });

  it('falls back to the UPID\'s 7th colon-separated field when id is empty', () => {
    expect(vmidOfTask(task({ upid: 'UPID:pve1:1:1:1:vzdump:113:msp360@pve:', id: '' }))).toBe('113');
  });

  it('returns "" when even the UPID has no 7th field', () => {
    expect(vmidOfTask(task({ upid: 'not-a-upid', id: '' }))).toBe('');
  });
});

describe('taskFinalState', () => {
  it('treats an absent status as running', () => {
    expect(taskFinalState(undefined)).toBe('running');
  });

  it('treats the literal "running" status as running', () => {
    expect(taskFinalState('running')).toBe('running');
  });

  it('treats "OK" as ok', () => {
    expect(taskFinalState('OK')).toBe('ok');
  });

  it('treats any other status as error', () => {
    expect(taskFinalState('ERROR: command failed with exit code 1')).toBe('error');
    expect(taskFinalState('some error')).toBe('error');
  });
});
