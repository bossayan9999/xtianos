import { useEffect, useState } from 'react'
import type { Project, Task, TaskStatus } from '@xtiand/shared'
import { TASK_STATUSES } from '@xtiand/shared'

import { api } from '../lib/api'

export function ProjectsPage() {
  const [projects, setProjects] = useState<(Project & { tasks: Task[] })[]>([])
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [newTask, setNewTask] = useState('')
  const [dragId, setDragId] = useState<number | null>(null)

  const load = (): void => {
    api
      .get<(Project & { tasks: Task[] })[]>('/api/projects')
      .then((rows) => {
        setProjects(rows)
        setActiveProjectId((prev) => prev ?? rows[0]?.id ?? null)
      })
      .catch(() => undefined)
    api.get<Task[]>('/api/tasks').then(setTasks).catch(() => undefined)
  }

  useEffect(load, [])

  const refreshTasks = (projectId: number | null): void => {
    const query = projectId === null ? '' : `?projectId=${projectId}`
    api.get<Task[]>(`/api/tasks${query}`).then(setTasks).catch(() => undefined)
  }

  useEffect(() => {
    refreshTasks(activeProjectId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  const createProject = async (): Promise<void> => {
    const name = prompt('project name')
    if (!name) return
    const goal = prompt('goal (optional)') ?? ''
    await api.post('/api/projects', { name, goal })
    load()
  }

  const addTask = async (): Promise<void> => {
    if (!newTask.trim()) return
    await api.post('/api/tasks', {
      title: newTask.trim(),
      projectId: activeProjectId,
    })
    setNewTask('')
    refreshTasks(activeProjectId)
    load()
  }

  const moveTask = async (taskId: number, status: TaskStatus): Promise<void> => {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status } : t)))
    await api.patch(`/api/tasks/${taskId}`, { status })
    refreshTasks(activeProjectId)
  }

  return (
    <div className="projects-page">
      <aside className="projects-sidebar">
        <button type="button" onClick={() => void createProject()}>
          + New project
        </button>
        <ul>
          <li>
            <button
              type="button"
              className={activeProjectId === null ? 'active' : ''}
              onClick={() => setActiveProjectId(null)}
            >
              All tasks
            </button>
          </li>
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={p.id === activeProjectId ? 'active' : ''}
                onClick={() => setActiveProjectId(p.id)}
              >
                {p.name}
                <small>{p.goal ? ` · ${p.goal.slice(0, 24)}` : ''}</small>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="board">
        <div className="board-input">
          <input
            placeholder="new task…"
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addTask()
            }}
          />
        </div>
        <div className="board-columns">
          {TASK_STATUSES.map((status) => (
            <section
              key={status}
              className={`board-column board-column--${status}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragId !== null) void moveTask(dragId, status)
                setDragId(null)
              }}
            >
              <h3>{status}</h3>
              <ul>
                {tasks
                  .filter((t) => t.status === status)
                  .map((task) => (
                    <li
                      key={task.id}
                      draggable
                      onDragStart={() => setDragId(task.id)}
                      className="task-card"
                    >
                      <span>{task.title}</span>
                      <div className="task-card__actions">
                        {TASK_STATUSES.filter((s) => s !== task.status).map((s) => (
                          <button key={s} type="button" onClick={() => void moveTask(task.id, s)}>
                            →{s}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            void api.del(`/api/tasks/${task.id}`).then(() => refreshTasks(activeProjectId))
                          }
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      </main>
    </div>
  )
}
