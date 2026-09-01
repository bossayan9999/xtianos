import { prisma } from '../lib/db';
import { runAgentLoop } from '@xtiand/mjane-core';

export interface AgentTask {
  id: string;
  agentName: string;
  goal: string;
  dependencies: string[]; // task IDs that must complete first
  deadline?: Date;
  priority: 'low' | 'normal' | 'high';
  retries: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

export class TaskOrchestrator {
  private tasks: Map<string, AgentTask> = new Map();
  private completedTasks: Set<string> = new Set();
  private failedTasks: Set<string> = new Set();

  /**
   * Add a task to the orchestrator.
   */
  addTask(task: AgentTask): void {
    this.tasks.set(task.id, task);
  }

  /**
   * Topological sort to determine execution order based on dependencies.
   */
  private topologicalSort(): AgentTask[] {
    const visited = new Set<string>();
    const sorted: AgentTask[] = [];
    const visiting = new Set<string>();

    const visit = (taskId: string): void => {
      if (visited.has(taskId)) return;
      if (visiting.has(taskId)) {
        throw new Error(`Circular dependency detected at task ${taskId}`);
      }

      visiting.add(taskId);
      const task = this.tasks.get(taskId);
      if (task) {
        for (const depId of task.dependencies) {
          visit(depId);
        }
        visiting.delete(taskId);
        visited.add(taskId);
        sorted.push(task);
      }
    };

    for (const taskId of this.tasks.keys()) {
      if (!visited.has(taskId)) {
        visit(taskId);
      }
    }

    return sorted.sort((a, b) => {
      const priorityMap = { high: 0, normal: 1, low: 2 };
      return priorityMap[a.priority] - priorityMap[b.priority];
    });
  }

  /**
   * Execute all tasks in dependency order.
   */
  async executeAll(): Promise<{
    completed: Map<string, unknown>;
    failed: Map<string, string>;
  }> {
    const sorted = this.topologicalSort();
    const results = new Map<string, unknown>();
    const errors = new Map<string, string>();

    for (const task of sorted) {
      // Check if dependencies succeeded
      const depsFailed = task.dependencies.some((depId) => this.failedTasks.has(depId));
      if (depsFailed) {
        task.status = 'failed';
        task.error = 'Dependency failed';
        this.failedTasks.add(task.id);
        errors.set(task.id, task.error);
        continue;
      }

      // Execute with retries
      let attempts = 0;
      while (attempts < task.retries) {
        try {
          task.status = 'running';
          const agent = await prisma.agent.findFirst({
            where: { name: task.agentName },
          });
          if (!agent) {
            throw new Error(`Agent ${task.agentName} not found`);
          }

          // Simulate agent execution
          task.result = `Task ${task.id} completed by ${task.agentName}`;
          task.status = 'completed';
          this.completedTasks.add(task.id);
          results.set(task.id, task.result);
          break;
        } catch (err) {
          attempts++;
          if (attempts >= task.retries) {
            task.status = 'failed';
            task.error = err instanceof Error ? err.message : String(err);
            this.failedTasks.add(task.id);
            errors.set(task.id, task.error);
          }
        }
      }
    }

    return { completed: results, failed: errors };
  }
}
