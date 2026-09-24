import { describe, expect, it } from 'vitest';
import { statusToColor, taskStatusState } from './status';

describe('statusToColor', () => {
  it('maps running/stopped/paused/suspended', () => {
    expect(statusToColor('running')).toBe('running');
    expect(statusToColor('stopped')).toBe('stopped');
    expect(statusToColor('paused')).toBe('paused');
    expect(statusToColor('suspended')).toBe('paused');
  });

  it('maps migrating and node online/offline', () => {
    expect(statusToColor('migrating')).toBe('migrating');
    expect(statusToColor('online')).toBe('running');
    expect(statusToColor('offline')).toBe('stopped');
  });

  it('maps unknown/undefined and error-ish strings to error', () => {
    expect(statusToColor(undefined)).toBe('error');
    expect(statusToColor('ERROR: boom')).toBe('error');
    expect(statusToColor('something-else')).toBe('error');
  });

  it('templates always win regardless of status', () => {
    expect(statusToColor('stopped', true)).toBe('template');
    expect(statusToColor('running', true)).toBe('template');
  });
});

describe('taskStatusState', () => {
  it('classifies OK as ok', () => {
    expect(taskStatusState('OK')).toBe('ok');
  });

  it('classifies missing status as running', () => {
    expect(taskStatusState(undefined)).toBe('running');
  });

  it('classifies the literal "running" status as running', () => {
    expect(taskStatusState('running')).toBe('running');
  });

  it('classifies anything else as error', () => {
    expect(taskStatusState('ERROR: command failed')).toBe('error');
  });
});
