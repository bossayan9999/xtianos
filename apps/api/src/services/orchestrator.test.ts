import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TaskOrchestrator, type AgentTask } from '../services/orchestrator-enhanced';

describe('Task Orchestrator', () => {
  let orchestrator: TaskOrchestrator;

  beforeAll(() => {
    orchestrator = new TaskOrchestrator();
  });

  afterAll(() => {
    // cleanup
  });

  it('should execute tasks in dependency order', async () => {
    const task1: AgentTask = {
      id: 'task-1',
      agentName: 'researcher',
      goal: 'Find information',
      dependencies: [],
      priority: 'normal',
      retries: 1,
      status: 'pending',
    };

    const task2: AgentTask = {
      id: 'task-2',
      agentName: 'coder',
      goal: 'Write code',
      dependencies: ['task-1'],
      priority: 'normal',
      retries: 1,
      status: 'pending',
    };

    orchestrator.addTask(task1);
    orchestrator.addTask(task2);

    const result = await orchestrator.executeAll();
    expect(result.completed.size).toBe(2);
    expect(result.failed.size).toBe(0);
  });

  it('should handle circular dependencies', () => {
    const badOrchestrator = new TaskOrchestrator();

    const task1: AgentTask = {
      id: 'task-a',
      agentName: 'agent1',
      goal: 'Goal A',
      dependencies: ['task-b'],
      priority: 'normal',
      retries: 1,
      status: 'pending',
    };

    const task2: AgentTask = {
      id: 'task-b',
      agentName: 'agent2',
      goal: 'Goal B',
      dependencies: ['task-a'],
      priority: 'normal',
      retries: 1,
      status: 'pending',
    };

    badOrchestrator.addTask(task1);
    badOrchestrator.addTask(task2);

    expect(() => badOrchestrator.executeAll()).rejects.toThrow('Circular dependency');
  });

  it('should skip tasks when dependencies fail', async () => {
    const skipOrchestrator = new TaskOrchestrator();

    const task1: AgentTask = {
      id: 'failing-task',
      agentName: 'nonexistent',
      goal: 'This will fail',
      dependencies: [],
      priority: 'normal',
      retries: 1,
      status: 'pending',
    };

    const task2: AgentTask = {
      id: 'dependent-task',
      agentName: 'coder',
      goal: 'Should be skipped',
      dependencies: ['failing-task'],
      priority: 'normal',
      retries: 1,
      status: 'pending',
    };

    skipOrchestrator.addTask(task1);
    skipOrchestrator.addTask(task2);

    const result = await skipOrchestrator.executeAll();
    expect(result.failed.size).toBeGreaterThan(0);
  });
});
